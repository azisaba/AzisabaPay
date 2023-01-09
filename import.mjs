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

!(async () => {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS \`packages\` (
      \`id\` BIGINT NOT NULL,
      \`yen\` INT NOT NULL,
      PRIMARY KEY (\`id\`)
    )
  `)
  const array = await fetch('https://plugin.tebex.io/packages', {
    method: 'GET',
    headers: {
      'X-Tebex-Secret': process.env.TEBEX_SECRET,
    },
  }).then((res) => res.json())
  for (const pkg of array) {
    if (pkg.custom_price) continue
    await pool.execute('INSERT INTO `packages` (`id`, `yen`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `yen` = VALUES(`yen`)', [ pkg.id, pkg.price ])
  }
  console.log('Done')
})()
