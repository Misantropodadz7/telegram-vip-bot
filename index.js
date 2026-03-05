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

    try {

        const body = req.body

        if (body.message) {

            const chatId = body.message.chat.id
            const text = body.message.text

            if (text === "/start") {

                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: chatId,
                    text: "💎 Assine o VIP para acessar conteúdos exclusivos",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Assinar VIP 💎", callback_data: "buy_vip" }]
                        ]
                    }
                })

            }

        }

        if (body.callback_query) {

            const callback = body.callback_query
            const chatId = callback.message.chat.id

            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                callback_query_id: callback.id
            })

            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: chatId,
                text: "Gerando pagamento..."
            })

        }

        res.sendStatus(200)

    } catch (error) {

        console.log("ERRO TELEGRAM:", error)
        res.sendStatus(200)

    }

})
app.post("/webhook", async (req, res) => {

    const event = req.body

    if (event.type === "checkout.session.completed") {

        const session = event.data.object
        const userId = users[session.id]

        if (userId) {

            const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/createChatInviteLink`, {
                chat_id: GROUP_ID,
                member_limit: 1
            })

            const inviteLink = response.data.result.invite_link

            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: userId,
                text: `🔓 Acesso liberado!\n\nEntre no grupo VIP:\n${inviteLink}`
            })

        }

    }

    res.sendStatus(200)

})

app.listen(PORT, () => {
    console.log("Server running on port " + PORT)
})

