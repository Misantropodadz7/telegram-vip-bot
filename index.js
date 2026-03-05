const express = require("express")
const bodyParser = require("body-parser")
const axios = require("axios")
const Stripe = require("stripe")

const app = express()
app.use(bodyParser.json())

const PORT = process.env.PORT || 8080

const BOT_TOKEN = process.env.BOT_TOKEN
const GROUP_ID = process.env.GROUP_ID
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`


// START DO BOT
app.post("/telegram", async (req, res) => {

const message = req.body.message
const callback = req.body.callback_query

try {

// COMANDO /start
if (message && message.text === "/start") {

await axios.post(`${TELEGRAM_API}/sendMessage`, {
chat_id: message.chat.id,
text: "🔥 Bem-vindo ao VIP 🔥\n\nClique abaixo para acessar o conteúdo exclusivo.",
reply_markup: {
inline_keyboard: [
[
{ text: "💎 Comprar VIP", callback_data: "buy_vip" }
]
]
}
})

}


// BOTÃO COMPRAR VIP
if (callback && callback.data === "buy_vip") {

const chatId = callback.message.chat.id

await axios.post(`${TELEGRAM_API}/sendMessage`, {
chat_id: chatId,
text: "Gerando pagamento..."
})

// CRIA PAGAMENTO STRIPE
const session = await stripe.checkout.sessions.create({
payment_method_types: ["card"],
line_items: [
{
price_data: {
currency: "brl",
product_data: {
name: "Acesso VIP"
},
unit_amount: 2000
},
quantity: 1
}
],
mode: "payment",
success_url: "https://t.me/ManuBelluccibot",
cancel_url: "https://t.me/ManuBelluccibot"
})

await axios.post(`${TELEGRAM_API}/sendMessage`, {
chat_id: chatId,
text: `💳 Pague aqui para entrar no VIP:\n${session.url}`
})

}

res.sendStatus(200)

} catch (error) {

console.log(error)

res.sendStatus(200)

}

})


// SERVER
app.listen(PORT, () => {
console.log("Server running on port " + PORT)
})
