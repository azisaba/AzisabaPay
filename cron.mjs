import dotenv from 'dotenv'
import fetch from 'node-fetch'
import mysql from 'mysql2/promise'
import { sendWebhook, roundUsd } from './util.mjs'

// loads .env file contents into process.env
dotenv.config()

const sleep = (millis) => new Promise((resolve) => setTimeout(() => resolve(), millis))

const API_EXECUTE_INTERVAL = 1500
let lastApiExecuted = 0
const executeAPI = async (url, params) => {
  const sleepMillis = API_EXECUTE_INTERVAL + (lastApiExecuted - Date.now())
  lastApiExecuted = Date.now()
  if (sleepMillis > 0) {
    await sleep(sleepMillis)
  }
  return await fetch(url, params)
}

!(async () => {
  try {
    const pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    })

    await pool.execute(`
    CREATE TABLE IF NOT EXISTS \`codes\` (
      \`id\` BIGINT NOT NULL,
      \`code\` VARCHAR(64) NOT NULL UNIQUE,
      \`yen\` INT NOT NULL,
      PRIMARY KEY (\`id\`)
    )
  `)
    await pool.execute(`
    CREATE TABLE IF NOT EXISTS \`packages\` (
      \`id\` BIGINT NOT NULL,
      \`yen\` INT NOT NULL,
      PRIMARY KEY (\`id\`)
    )
  `)
    await pool.execute(`
    CREATE TABLE IF NOT EXISTS \`config\` (
      \`key\` VARCHAR(127) NOT NULL,
      \`value\` VARCHAR(127) NOT NULL,
      PRIMARY KEY (\`key\`)
    )
  `)
    const oxrData = await fetch(`https://openexchangerates.org/api/latest.json?app_id=${process.env.OXR_APP_ID}&prettyprint=false&show_alternative=false`, {
      headers: {
        accept: 'application/json',
      },
    }).then((res) => res.json())
    if (!oxrData.rates) {
      await sendWebhook(`OpenExchangeRatesが有効なデータを含んでいないため、データ更新をスキップしました\n\`\`\`json\n${JSON.stringify(oxrData)}\n\`\`\``)
      console.error('OXR returned error', oxrData)
      return process.exit(0)
    }
    const rateUsdJpy = oxrData.rates.JPY
    if (!rateUsdJpy) {
      await sendWebhook(`OpenExchangeRatesがJPYのデータを含んでいないため、データ更新をスキップしました\n\`\`\`json\n${JSON.stringify(oxrData)}\n\`\`\``)
      console.error('OXR did not return rate data for JPY', oxrData)
      return process.exit(0)
    }
    if (rateUsdJpy < 100) {
      // to prevent accidents like "all packages are now $1"
      await sendWebhook(`為替レートが100円未満のため、データ更新をスキップしました (${rateUsdJpy}円)`)
      throw new Error(`rate is too low (${rateUsdJpy})`)
    }
    await pool.execute('INSERT INTO `config` (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)', ['rate_usd_jpy', rateUsdJpy.toString()])
    console.log('Set rate_usd_jpy to ' + rateUsdJpy)
    const array = await pool.query('SELECT * FROM `packages`')
    for (const pkg of array[0]) {
      const usd = roundUsd(pkg.yen / rateUsdJpy, true)
      if (!isFinite(usd) || isNaN(usd)) {
        await sendWebhook(`Package ${pkg.id}の変換後のUSD価格が不正な値です: ${usd} (ベースとする価格: ${pkg.yen}円, レート: ${rateUsdJpy}円)`)
        throw new Error(`Invalid value: ${usd}`)
      }
      console.log(`Setting price of ${pkg.id} to ${usd}`)
      const res = await executeAPI(`https://plugin.tebex.io/package/${pkg.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Tebex-Secret': process.env.TEBEX_SECRET,
        },
        body: JSON.stringify({
          price: usd,
        }),
      })
      if (res.status < 200 && res.status > 299) {
        const rawResponse = await res.text()
        await sendWebhook(`Failed to update package ${pkg.id} (status: ${res.status})\n\`\`\`\n${response}\n\`\`\``)
        console.error(`Failed to update package ${pkg.id}`)
        console.error(rawResponse)
        throw new Error()
      }
    }
    console.log(`Updated ${array[0].length} packages`)
    const coupons = await pool.query('SELECT * FROM `codes`')
    for (const coupon of coupons[0]) {
      const usd = roundUsd(coupon.yen / rateUsdJpy)
      if (!isFinite(usd) || isNaN(usd)) {
        throw new Error(`Invalid value: ${usd}`)
      }
      console.log(`Setting value of coupon ${coupon.code} (ID: ${coupon.id}) to ${usd} USD`)
      const oldCoupon = await executeAPI('https://plugin.tebex.io/coupons/' + coupon.id, {
        headers: { 'X-Tebex-Secret': process.env.TEBEX_SECRET },
      }).then((res) => res.json())
      if (!oldCoupon.data || (oldCoupon.data.expire.redeem_unlimited === 'false' && oldCoupon.data.expire.limit <= 0)) {
        // coupon deleted or expired (used)
        await sendWebhook(`Coupon \`${coupon.code}\` (ID: ${coupon.id}) が使用済みか削除されているため、データベースから削除しました\n\`\`\`json\n${JSON.stringify(oldCoupon)}\n\`\`\``)
        console.log(`Deleting coupon ${coupon.code} (coupon does not exist or is expired)`)
        await pool.execute('DELETE FROM `codes` WHERE `id` = ?', [coupon.id])
        continue
      }
      const deleteResult = await executeAPI('https://plugin.tebex.io/coupons/' + coupon.id, {
        method: 'DELETE',
        headers: {
          'X-Tebex-Secret': process.env.TEBEX_SECRET,
        },
      })
      if (deleteResult.status !== 204 && deleteResult.status !== 404) {
        const rawResponse = await deleteResult.text()
        await sendWebhook(`Coupon \`${coupon.code}\` (ID: ${coupon.id}) の削除に失敗しました\n\`\`\`json\n${rawResponse}\n\`\`\``)
        console.error(`Failed to delete coupon ${coupon.id}`)
        console.error(rawResponse)
        throw new Error()
      }
      await pool.execute('DELETE FROM `codes` WHERE `id` = ?', [coupon.id])
      if (deleteResult.status === 404) {
        // this should never happen
        console.log(`Deleting coupon ${coupon.code} (delete coupon returned 404)`)
        continue
      }
      const postBody = {
        code: coupon.code,
        effective_on: oldCoupon.data.effective.type,
        packages: oldCoupon.data.effective.packages,
        categories: oldCoupon.data.effective.categories,
        discount_type: oldCoupon.data.discount.type,
        discount_percentage: oldCoupon.data.discount.percentage,
        discount_amount: usd,
        redeem_unlimited: oldCoupon.data.expire.redeem_unlimited,
        expire_never: oldCoupon.data.expire.expire_never,
        expire_limit: oldCoupon.data.expire.limit,
        basket_type: oldCoupon.data.basket_type,
        user_limit: oldCoupon.data.user_limit,
        minimum: oldCoupon.data.minimum,
        username: oldCoupon.data.username,
        note: oldCoupon.data.note,
        discount_application_method: 1,
      }
      // create coupon
      const response = await executeAPI('https://plugin.tebex.io/coupons', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tebex-Secret': process.env.TEBEX_SECRET,
        },
        body: JSON.stringify(postBody),
      }).then((res) => res.json())
      const couponId = response?.data?.id
      if (!couponId) {
        await sendWebhook(`Coupon \`${coupon.code}\`の更新に失敗しました\nBody:\n\`\`\`json\n${JSON.stringify(postBody)}\n\`\`\`\nResponse:\n\`\`\`json\n${JSON.stringify(response)}\n\`\`\``)
        console.error(`Failed to create coupon ${coupon.code}`, postBody)
        continue
      }
      // insert into codes table
      await pool.execute('INSERT INTO `codes` (`id`, `code`, `yen`) VALUES (?, ?, ?)', [couponId, coupon.code, coupon.yen])
      console.log(`Renewed coupon ${coupon.code} -> ${couponId}`)
    }
    console.log(`Updated ${coupons[0].length} coupons`)
  } catch (e) {
    console.error(e.stack || e)
    await sendWebhook(`更新処理中に不明なエラーが発生しました\n\`\`\`\n${e.stack || e}\n\`\`\``)
  } finally {
    process.exit(0)
  }
})()
