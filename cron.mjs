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

!(async () => {
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
  await pool.execute('INSERT INTO `config` (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)', [ 'rate_usd_jpy', rateUsdJpy.toString() ])
  console.log('Set rate_usd_jpy to ' + rateUsdJpy)
  const array = await pool.execute('SELECT * FROM `packages`')
  for (const pkg of array[0]) {
    const usd = roundUsd(pkg.yen / rateUsdJpy)
    console.log(`Setting price of ${pkg.id} to ${usd}`)
    // TODO: implement
  }
  process.exit(0)
})()
