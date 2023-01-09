import dotenv from 'dotenv'
import { Client, IntentsBitField } from 'discord.js'
import crypto from 'crypto'
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

const generateCode = (length) => {
  const charPool = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789'.split('')
  let s = ''
  for (let i = 0; i < length; i++) {
    s += charPool[Math.floor(crypto.randomInt(charPool.length))]
  }
  return s
}

const roundUsd = (usd) => Math.floor(usd * 100) / 100

const client = new Client({
  intents: [
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.GuildMessageReactions,
    IntentsBitField.Flags.MessageContent, // Privileged
  ]
})

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`)
})

client.on('raw', async (p) => {
  if (p.t === 'MESSAGE_REACTION_ADD' && p.d.channel_id === process.env.CHANNEL_ID &&
      p.d.user_id === process.env.USER_ID && p.d.emoji.name === '✅') {
    const user = await client.users.fetch(process.env.USER_ID)
    const channel = await client.channels.fetch(p.d.channel_id)
    const message = await channel.messages.fetch(p.d.message_id)
    const props = {}
    for (const line of message.content.split('\n')) {
      const arr = line.split(':')
      if (arr.length < 2) continue
      props[arr[0].trim()] = arr[1].trim()
    }
    if (!props['MCID'] || !props['DiscordID'] || !props['金額']) {
      return // missing one or more properties
    }
    const minecraftAccount = await fetch('https://api.mojang.com/users/profiles/minecraft/' + props['MCID']).then((res) => res.json())
    if (!minecraftAccount.id) {
      // player doesn't exist?
      return user.send(`MCID \`${props['MCID']}\`が見つかりません`)
    }
    const targetUser = await client.users.fetch(props['DiscordID']).catch((e) => {
      user.send(`Discordユーザー\`${props['DiscordID']}\`が見つかりません\n\`\`\`\n${e.stack || e}\n\`\`\``)
      return null
    })
    if (!targetUser) return
    const yen = parseInt(props['金額'])
    if (!isFinite(yen) || isNaN(yen)) {
      return user.send(`金額 \`${props['金額']}\`は無効な値です`)
    }
    const code = generateCode(15)
    const rateUsdJpy = 120 // TODO
    const usd = roundUsd(yen / rateUsdJpy)
    if (!isFinite(usd) || isNaN(usd)) {
      console.error(`${usd} USD is invalid (yen: ${yen}, rate: ${rateUsdJpy})`)
      return user.send(`金額(USD) \`${usd}\`は無効な値です`)
    }
    const body = {
      code,
      discount_amount: usd,
      username: minecraftAccount.id,
      discount_type: 'value',
      discount_percentage: 0,
      expire_limit: 1,
      minimum: 0,
      discount_application_method: 1,
      effective_on: 'cart',
      basket_type: 'both',
      redeem_unlimited: false,
      expire_never: true,
    }
    const response = await fetch('https://plugin.tebex.io/coupons', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tebex-Secret': process.env.TEBEX_SECRET,
      },
      body: JSON.stringify(body),
    }).then((res) => res.json())
    const couponId = response?.data?.id
    if (!couponId) {
      console.error(`Error returned from Tebex:`, response)
      console.error('Request body:', body)
      user.send(`クーポンの作成に失敗しました\n\`\`\`\n${response.error_message}\n\`\`\``)
      return
    }
    try {
      await pool.execute('INSERT INTO `codes` (`id`, `code`, `yen`) VALUES (?, ?, ?)', [couponId, code, yen])
    } catch (e) {
      user.send(`データベースの操作に失敗しました\n\`\`\`\n${e.stack || e}\n\`\`\``)
      fetch('https://plugin.tebex.io/coupons/' + couponId, {
        method: 'DELETE',
        headers: {
          'X-Tebex-Secret': process.env.TEBEX_SECRET,
        },
      }).then((res) => {
        if (res.status < 200 || res.status >= 300) {
          console.error(`Failed to delete coupon id ${couponId} (code: ${code}, amount: ${yen})`)
        }
      }).catch((e) => {
        console.error(`Failed to delete coupon id ${couponId} (code: ${code}, amount: ${yen})`)
        console.error(e.stack || e)
      })
      return
    }
    console.log(`New code generated: MU: ${props['MCID']}, MUU: ${minecraftAccount.id}, DU: ${props['DiscordID']}, C: ${code}, I: ${couponId}, AJ: ${yen}, AU: ${usd}`)
    user.send(`Amazonギフト券の処理が完了し、クーポンを発行しました\nMCID: \`${props['MCID']}\`\nUUID: \`${minecraftAccount.id}\`\nコード: \`${code}\`\n金額: ${yen}円 (${usd} USD)`)
    targetUser.send(`Amazonギフト券の処理が完了しました。\nMCID: \`${props['MCID']}\`\nUUID: \`${minecraftAccount.id}\`\nクーポンコード(<https://store.azisaba.net>で使用できます): \`${code}\`\n金額: ${yen}円 (${usd} USD)`)
  }
})

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
    CREATE TABLE IF NOT EXISTS \`config\` (
      \`key\` VARCHAR(127) NOT NULL,
      \`value\` VARCHAR(127) NOT NULL,
      PRIMARY KEY (\`id\`)
    )
  `)
  client.login(process.env.BOT_TOKEN)
})()
