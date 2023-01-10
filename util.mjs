import fetch from 'node-fetch'

export const sendWebhook = async (text) => {
  const webhookUrl = process.env.DISCORD_WEBHOOK_ON_ERROR
  if (!webhookUrl) {
    // empty webhook url
    return
  }
  return await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'AzisabaPay - https://github.com/azisaba/AzisabaPay',
    },
    body: JSON.stringify({
      content: text,
    })
  }).then(async (res) => {
    if (res.status < 200 || res.status > 299) {
      console.error(`Discord webhook returned error: ${await res.text()}`)
    }
    return res
  })
}
