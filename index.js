const express = require("express")
const bodyParser = require("body-parser")
const axios = require("axios")
const Stripe = require("stripe")

const app = express()

const PORT = process.env.PORT || 8080
const BOT_TOKEN = process.env.BOT_TOKEN
const GROUP_ID = process.env.GROUP_ID
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET // Adicione esta variável no Railway
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

// ⚠️ IMPORTANTE: O endpoint do webhook do Stripe precisa do body RAW (não JSON parseado)
// Por isso, o bodyParser.raw() é aplicado ANTES do bodyParser.json()
app.use("/stripe-webhook", bodyParser.raw({ type: "application/json" }))

// Para todas as outras rotas, usa JSON normal
app.use(bodyParser.json())

// ─────────────────────────────────────────
// ENDPOINT DO TELEGRAM
// ─────────────────────────────────────────
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
              { text: "💎 Ver opções de assinatura", callback_data: "show_plans" }
            ]
          ]
        }
      })
    }

    // BOTÃO: VER OPÇÕES DE ASSINATURA
    // CORREÇÃO 1: Adicionado answerCallbackQuery para fechar o "loading" do botão
    if (callback && callback.data === "show_plans") {
      // ✅ SEMPRE responda o callback imediatamente para parar o loading do botão
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: callback.id
      })

      const chatId = callback.message.chat.id

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "💎 Escolha seu plano VIP:",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⭐ Mensal - R$ 20,00", callback_data: "buy_monthly" }],
            [{ text: "🗓️ Trimestral - R$ 50,00", callback_data: "buy_quarterly" }],
            [{ text: "☀️ Semestral - R$ 90,00", callback_data: "buy_semiannual" }],
            [{ text: "🏆 Anual - R$ 150,00", callback_data: "buy_yearly" }]
          ]
        }
      })
    }

    // BOTÃO: COMPRAR PLANO MENSAL
    if (callback && callback.data === "buy_monthly") {
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: callback.id
      })

      const chatId = callback.message.chat.id

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "⏳ Gerando link de pagamento..."
      })

      // CORREÇÃO 2: Usar mode: "subscription" para assinatura recorrente
      // CORREÇÃO 3: Salvar o chat_id nos metadata para usar no webhook
      // ⚠️ Substitua "price_SEU_PRICE_ID_MENSAL" pelo Price ID criado no Stripe Dashboard
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            // Use o Price ID do produto recorrente criado no Stripe Dashboard
            price: process.env.STRIPE_PRICE_MONTHLY, // ex: price_1ABC123...
            quantity: 1
          }
        ],
        mode: "subscription", // ✅ Assinatura recorrente
        metadata: {
          telegram_chat_id: String(chatId) // ✅ Salva o chat_id para usar no webhook
        },
        success_url: "https://t.me/ManuBelluccibot",
        cancel_url: "https://t.me/ManuBelluccibot"
      })

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `💳 Clique abaixo para pagar e entrar no VIP:\n\n${session.url}`
      })
    }

    // BOTÃO: COMPRAR PLANO TRIMESTRAL
    if (callback && callback.data === "buy_quarterly") {
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: callback.id
      })

      const chatId = callback.message.chat.id

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "⏳ Gerando link de pagamento..."
      })

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price: process.env.STRIPE_PRICE_QUARTERLY, // ex: price_1QRT...
            quantity: 1
          }
        ],
        mode: "subscription",
        metadata: {
          telegram_chat_id: String(chatId)
        },
        success_url: "https://t.me/ManuBelluccibot",
        cancel_url: "https://t.me/ManuBelluccibot"
      })

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `💳 Clique abaixo para pagar e entrar no VIP:\n\n${session.url}`
      })
    }

    // BOTÃO: COMPRAR PLANO SEMESTRAL
    if (callback && callback.data === "buy_semiannual") {
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: callback.id
      })

      const chatId = callback.message.chat.id

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "⏳ Gerando link de pagamento..."
      })

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price: process.env.STRIPE_PRICE_SEMIANNUAL, // ex: price_1SEM...
            quantity: 1
          }
        ],
        mode: "subscription",
        metadata: {
          telegram_chat_id: String(chatId)
        },
        success_url: "https://t.me/ManuBelluccibot",
        cancel_url: "https://t.me/ManuBelluccibot"
      })

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `💳 Clique abaixo para pagar e entrar no VIP:\n\n${session.url}`
      })
    }

    // BOTÃO: COMPRAR PLANO ANUAL
    if (callback && callback.data === "buy_yearly") {
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: callback.id
      })

      const chatId = callback.message.chat.id

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "⏳ Gerando link de pagamento..."
      })

      // ⚠️ Substitua "price_SEU_PRICE_ID_ANUAL" pelo Price ID criado no Stripe Dashboard
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price: process.env.STRIPE_PRICE_YEARLY, // ex: price_1XYZ456...
            quantity: 1
          }
        ],
        mode: "subscription",
        metadata: {
          telegram_chat_id: String(chatId)
        },
        success_url: "https://t.me/ManuBelluccibot",
        cancel_url: "https://t.me/ManuBelluccibot"
      })

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `💳 Clique abaixo para pagar e entrar no VIP:\n\n${session.url}`
      })
    }

    res.sendStatus(200)
  } catch (error) {
    console.error("Erro no handler do Telegram:", error.message)
    res.sendStatus(200) // Sempre retorna 200 para o Telegram não reenviar o update
  }
})

// ─────────────────────────────────────────
// ENDPOINT DO WEBHOOK DO STRIPE
// CORREÇÃO 4: Endpoint separado para receber confirmações de pagamento do Stripe
// ─────────────────────────────────────────
app.post("/stripe-webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"]

  let event

  try {
    // ✅ Valida a assinatura do webhook para garantir que veio do Stripe
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error("Webhook inválido:", err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  // Pagamento de assinatura confirmado
  if (event.type === "checkout.session.completed") {
    const session = event.data.object

    // Recupera o chat_id salvo nos metadata
    const chatId = session.metadata?.telegram_chat_id

    if (chatId) {
      try {
        // ✅ Gera um link de convite único para o grupo
        const inviteResponse = await axios.post(
          `${TELEGRAM_API}/createChatInviteLink`,
          {
            chat_id: GROUP_ID,
            member_limit: 1, // Link de uso único
            expire_date: Math.floor(Date.now() / 1000) + 86400 // Expira em 24h
          }
        )

        const inviteLink = inviteResponse.data.result.invite_link

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `✅ Pagamento confirmado! Bem-vindo ao VIP!\n\n🔗 Entre pelo link abaixo (válido por 24h):\n${inviteLink}`
        })
      } catch (err) {
        console.error("Erro ao gerar invite link:", err.message)
      }
    }
  }

  res.sendStatus(200)
})

// ─────────────────────────────────────────
// SERVER
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log("Server running on port " + PORT)
})
