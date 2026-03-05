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

let users = {}

app.get("/", (req, res) => {
  res.send("Bot running")
})

app.post("/telegram", async (req, res) => {

  const body = req.body

  if (body.message) {

    const chatId = body.message.chat.id
    const text = body.message.text

    if (text === "/start") {

      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: "💎 Escolha seu plano VIP",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 mês €9.90", callback_data: "plan_1" }],
            [{ text: "3 meses €24.90", callback_data: "plan_3" }],
            [{ text: "6 meses €39.90", callback_data: "plan_6" }],
            [{ text: "1 ano €69.90", callback_data: "plan_12" }]
          ]
        }
      })

    }

  }

  if (body.callback_query) {

    const chatId = body.callback_query.message.chat.id
    const userId = body.callback_query.from.id
    const plan = body.callback_query.data

    let price = 990

    if (plan === "plan_3") price = 2490
    if (plan === "plan_6") price = 3990
    if (plan === "plan_12") price = 6990

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: "VIP Telegram Access"
            },
            unit_amount: price
          },
          quantity: 1
        }
      ],
      mode: "payment",
      success_url: "https://t.me",
      cancel_url: "https://t.me"
    })

    users[session.id] = userId

    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: `💳 Pague aqui:\n${session.url}`
    })

  }

  res.sendStatus(200)

})

app.post("/webhook", async (req, res) => {

  const event = req.body

  if (event.type === "checkout.session.completed") {

    const session = event.data.object
    const userId = users[session.id]

    if (userId) {

      const invite = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/createChatInviteLink`, {
        chat_id: GROUP_ID,
        member_limit: 1
      })

      const inviteLink = invite.data.result.invite_link

      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: `🔓 Pagamento confirmado!\n\nEntre no grupo VIP:\n${inviteLink}`
      })

    }

  }

  res.sendStatus(200)

})

app.listen(PORT, () => {
  console.log("Server running on port " + PORT)
})
