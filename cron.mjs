import dotenv from 'dotenv'
import fetch from 'node-fetch'
import mysql from 'mysql2/promise'

// loads .env file contents into process.env
dotenv.config()

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
})

const roundUsd = (usd) => Math.floor(usd * 100) / 100

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
    console.error('OXR returned error', oxrData)
    return process.exit(0)
  }
  const rateUsdJpy = oxrData.rates.JPY
  if (!rateUsdJpy) {
    console.error('OXR did not return rate data for JPY', oxrData)
    return process.exit(0)
  }
  if (rateUsdJpy < 100) {
    throw new Error(`rate is too low (${rateUsdJpy})`)
  }
  await pool.execute('INSERT INTO `config` (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)', [ 'rate_usd_jpy', rateUsdJpy.toString() ])
  console.log('Set rate_usd_jpy to ' + rateUsdJpy)
  const array = await pool.query('SELECT * FROM `packages`')
  for (const pkg of array[0]) {
    const usd = roundUsd(pkg.yen / rateUsdJpy)
    if (!isFinite(usd) || isNaN(usd)) {
      throw new Error(`Invalid value: ${usd}`)
    }
    console.log(`Setting price of ${pkg.id} to ${usd}`)
    /*
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
    if (res.status !== 204) {
      console.error(`Failed to update package ${pkg.id}`)
      console.error(await res.text())
      throw new Error()
    }
    */
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
    console.log(oldCoupon)
    if (!oldCoupon.data || (oldCoupon.data.expire.redeem_unlimited === 'false' && oldCoupon.data.expire.limit <= 0)) {
      // coupon deleted or expired (used)
      console.log(`Deleting coupon ${coupon.code} (coupon does not exist or is expired)`)
      await pool.execute('DELETE FROM `codes` WHERE `id` = ?', [ coupon.id ])
      continue
    }
    const deleteResult = await executeAPI('https://plugin.tebex.io/coupons/' + coupon.id, {
      method: 'DELETE',
      headers: {
        'X-Tebex-Secret': process.env.TEBEX_SECRET,
      },
    })
    if (deleteResult.status !== 204 && deleteResult.status !== 404) {
      console.error(`Failed to delete coupon ${coupon.id}`)
      console.error(await deleteResult.text())
      throw new Error()
    }
    await pool.execute('DELETE FROM `codes` WHERE `id` = ?', [ coupon.id ])
    if (deleteResult.status === 404) {
      console.log(`Deleting coupon ${coupon.code} (delete coupon returned 404)`)
      // coupon deleted??
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
      console.error(`Failed to create coupon ${coupon.code}`, postBody)
      continue
    }
    // insert into codes table
    await pool.execute('INSERT INTO `codes` (`id`, `code`, `yen`) VALUES (?, ?, ?)', [couponId, coupon.code, coupon.yen])
    console.log(`Renewed coupon ${coupon.code} -> ${couponId}`)
  }
  console.log(`Updated ${coupons[0].length} coupons`)
  process.exit(0)
})()
