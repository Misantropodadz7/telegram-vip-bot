const express = require("express")
const bodyParser = require("body-parser")
const axios = require("axios")
const mongoose = require("mongoose")
const { google } = require("googleapis")

const app = express()
const PORT = process.env.PORT || 3000

// TELEGRAM
const BOT_TOKEN = process.env.BOT_TOKEN
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

// PAGAMENTO
const TRUST_WALLET_ADDRESS = process.env.TRUST_WALLET_ADDRESS?.trim() || ""
const LIVEPIX_URL = process.env.LIVEPIX_URL?.trim() || ""
const OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID?.trim() || ""

// GRUPOS
const VIP_BR_GROUP_ID = process.env.VIP_BR_GROUP_ID?.trim() || ""
const VIP_INT_GROUP_ID = process.env.VIP_INT_GROUP_ID?.trim() || ""

// OUTROS
const PRIVACY_PROFILE_URL = process.env.PRIVACY_PROFILE_URL?.trim() || ""
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL?.trim() || ""
const MONGODB_URI = process.env.MONGODB_URI
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || ""

let sheetsClient = null

// GOOGLE SHEETS
async function initializeGoogleSheets() {

try {

```
if (!process.env.GOOGLE_CREDENTIALS_JSON) {
  console.log("Google Sheets não configurado")
  return
}

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
})

sheetsClient = google.sheets({
  version: "v4",
  auth
})

console.log("Google Sheets conectado")
```

} catch (err) {

```
console.log("Erro Google Sheets:", err.message)
```

}

}

// PLANOS
const plansConfig = {

br: {
group_id: VIP_BR_GROUP_ID,
plans: {
monthly: { label: "Mensal", price_display: "R$ 29,90", price_usd: "6", days: 30 },
quarterly: { label: "Trimestral", price_display: "R$ 76,24", price_usd: "15", days: 90 },
semiannual: { label: "Semestral", price_display: "R$ 134,55", price_usd: "33", days: 180 }
}
},

int: {
group_id: VIP_INT_GROUP_ID,
plans: {
monthly: { label: "Monthly", price_display: "$11", price_usd: "11", days: 30 },
quarterly: { label: "Quarterly", price_display: "$28", price_usd: "28", days: 90 },
semiannual: { label: "Semiannual", price_display: "$49", price_usd: "49", days: 180 }
}
}

}

// SCHEMAS

const pendingPaymentSchema = new mongoose.Schema({

_id: Number,
userId: Number,
userName: String,
groupKey: String,
planKey: String,
paymentMethod: String,
timestamp: { type: Date, default: Date.now }

})

const subscriptionSchema = new mongoose.Schema({

_id: Number,
userId: Number,
chatId: Number,
groupKey: String,
planKey: String,
expiresAt: Date,
status: { type: String, default: "active" }

})

const PendingPayment = mongoose.model("PendingPayment", pendingPaymentSchema)
const Subscription = mongoose.model("Subscription", subscriptionSchema)

app.use(bodyParser.json())

// TELEGRAM WEBHOOK
app.post("/telegram", async (req, res) => {

const { message, callback_query } = req.body
const callback = callback_query

if (!message && !callback) return res.sendStatus(200)

try {

```
const chatId = message?.chat.id || callback?.message.chat.id
const userId = message?.from.id || callback?.from.id
const username = message?.from.username || callback?.from.username || "User"

// START
if (message?.text === "/start") {

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
}
    chat_id: chatId,
    text: "Escolha seu grupo VIP",

    reply_markup: {
      inline_keyboard: [
        [{ text: "VIP BR", callback_data: "plans_br" }],
        [{ text: "VIP INT", callback_data: "plans_int" }]
      ]
    }

  })

}

// PLANOS
if (callback && callback.data.startsWith("plans_")) {

  const groupKey = callback.data.split("_")[1]
  const config = plansConfig[groupKey]

  const keyboard = Object.keys(config.plans).map(p => {

    const plan = config.plans[p]

    return [{
      text: `${plan.label} - ${plan.price_display}`,
      callback_data: `buy_${groupKey}_${p}`
    }]

  })

  await axios.post(`${TELEGRAM_API}/sendMessage`, {

    chat_id: chatId,
    text: "Escolha seu plano",
    reply_markup: { inline_keyboard: keyboard }

  })

}

// COMPRA
if (callback && callback.data.startsWith("buy_")) {

  const [, groupKey, planKey] = callback.data.split("_")

  await PendingPayment.findByIdAndUpdate(

    chatId,
    {
      _id: chatId,
      userId,
      userName: username,
      groupKey,
      planKey
    },
    { upsert: true }

  )

  await axios.post(`${TELEGRAM_API}/sendMessage`, {

    chat_id: chatId,
    text: "Envie o comprovante aqui"

  })

}

// RECEBER COMPROVANTE
if (message?.photo || message?.document) {

  const payment = await PendingPayment.findById(chatId)

  if (!payment) return

  if (OWNER_TELEGRAM_ID) {

    await axios.post(`${TELEGRAM_API}/sendMessage`, {

      chat_id: OWNER_TELEGRAM_ID,
      text: `Comprovante recebido de @${payment.userName}\nID: ${chatId}`

    })

  }

  await axios.post(`${TELEGRAM_API}/sendMessage`, {

    chat_id: chatId,
    text: "Comprovante recebido. Aguarde aprovação."

  })

}

// APROVAR
if (message?.text?.startsWith("/aprovar")) {

  if (userId.toString() !== OWNER_TELEGRAM_ID) return

  const clientId = parseInt(message.text.split(" ")[1])

  const payment = await PendingPayment.findById(clientId)

  if (!payment) return

  const plan = plansConfig[payment.groupKey].plans[payment.planKey]

  const invite = await generateInvite(plansConfig[payment.groupKey].group_id)

  if (!invite) {

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: clientId,
      text: "Erro ao gerar link de acesso."
    })

    return
  }

  const expires = new Date(Date.now() + plan.days * 86400000)

  await Subscription.findByIdAndUpdate(

    payment.userId,
    {
      _id: payment.userId,
      userId: payment.userId,
      chatId: clientId,
      groupKey: payment.groupKey,
      planKey: payment.planKey,
      expiresAt: expires
    },
    { upsert: true }

  )

  await axios.post(`${TELEGRAM_API}/sendMessage`, {

    chat_id: clientId,
    text: "Pagamento aprovado",

    reply_markup: {
      inline_keyboard: [[{ text: "Entrar no grupo", url: invite }]]
    }

  })

  await PendingPayment.deleteOne({ _id: clientId })

}

res.sendStatus(200)
```

} catch (err) {

```
console.log("Erro telegram:", err.message)
res.sendStatus(200)
```

}

})

// GERAR LINK
async function generateInvite(groupId) {

try {

```
const expire = Math.floor(Date.now() / 1000) + (30 * 60)

const r = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, {

  chat_id: groupId,
  member_limit: 1,
  expire_date: expire

})

return r.data.result.invite_link
```

} catch (err) {

```
console.log("Erro link:", err.message)
return null
```

}

}

// HEALTH
app.get("/health", (req, res) => {

res.json({
status: "ok",
time: new Date()
})

})

// START
async function start() {

try {

```
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN não configurado")
  process.exit(1)
}

if (!MONGODB_URI) {
  console.error("MONGODB_URI não configurado")
  process.exit(1)
}

await mongoose.connect(MONGODB_URI)

console.log("MongoDB conectado")

await initializeGoogleSheets()

if (WEBHOOK_BASE_URL) {

  await axios.get(`${TELEGRAM_API}/setWebhook?url=${WEBHOOK_BASE_URL}/telegram`)
  console.log("Webhook configurado")

}

app.listen(PORT, () => {

  console.log("Servidor rodando porta", PORT)

})
```

} catch (err) {

```
console.log("Erro start:", err.message)
```

}

}

start()




