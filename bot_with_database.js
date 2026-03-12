const express = require("express")
const bodyParser = require("body-parser")
const axios = require("axios")
const mongoose = require("mongoose")

const app = express()
const PORT = process.env.PORT || 3000

// TELEGRAM
const BOT_TOKEN = process.env.BOT_TOKEN
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

// VARIÁVEIS DE AMBIENTE
const OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID?.trim() || ""
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL?.trim() || ""
const MONGODB_URI = process.env.MONGODB_URI?.trim() || ""
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID?.trim() || ""
const VIP_BR_GROUP_ID = process.env.GROUP_ID_BR?.trim() || ""
const VIP_INT_GROUP_ID = process.env.GROUP_ID_INT?.trim() || ""

// MIDDLEWARES
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))

// ROTA DE TESTE
app.get("/", (req, res) => {
  res.send(`<h1>Bot Online e Protegido!</h1><p>Status: Ativo e aguardando Telegram.</p>`)
})

// TELEGRAM WEBHOOK
app.post("/telegram", async (req, res) => {
  const { message, callback_query } = req.body
  res.sendStatus(200)

  try {
    const chatId = message?.chat?.id || callback_query?.message?.chat?.id
    const userId = message?.from?.id || callback_query?.from?.id
    const username = message?.from?.username || callback_query?.from?.username || "User"
    const text = message?.text || ""
    const callbackData = callback_query?.data

    // Lógica do Comando /start
    if (text.startsWith("/start")) {
      await sendMessage(chatId, "Escolha seu grupo VIP:", {
        inline_keyboard: [
          [{ text: "VIP BR 🇧🇷", callback_data: "plans_br" }],
          [{ text: "VIP INT 🌎", callback_data: "plans_int" }]
        ]
      })
    }

    // Lógica de Planos (Callback)
    if (callbackData?.startsWith("plans_")) {
      const groupKey = callbackData.split("_")[1]
      const plans = getPlansConfig()[groupKey]?.plans
      if (plans) {
        const keyboard = Object.keys(plans).map(key => ([{
          text: `${plans[key].label} - ${plans[key].price_display}`,
          callback_data: `buy_${groupKey}_${key}`
        }]))
        await sendMessage(chatId, "Escolha seu plano:", { inline_keyboard: keyboard })
      }
    }

    // Lógica de Compra (Início do Checkout)
    if (callbackData?.startsWith("buy_")) {
      const [, groupKey, planKey] = callbackData.split("_")
      if (mongoose.connection.readyState === 1) {
        const PendingPayment = mongoose.model("PendingPayment")
        // Registra a intenção de compra (Estado: Aguardando Comprovante)
        await PendingPayment.findByIdAndUpdate(
          chatId,
          { _id: chatId, userId, userName: username, groupKey, planKey, status: "awaiting_receipt" },
          { upsert: true, new: true }
        )
        await sendMessage(chatId, "Por favor, envie o comprovante de pagamento (Foto ou PDF) aqui no chat.")
      }
    }

    // RECEBIMENTO E ENCAMINHAMENTO DE COMPROVANTE (Com Proteção contra Spam)
    if (message?.photo || message?.document) {
      if (mongoose.connection.readyState === 1) {
        const PendingPayment = mongoose.model("PendingPayment")
        const payment = await PendingPayment.findById(chatId)

        // SÓ ENCAMINHA SE O USUÁRIO ESTIVER AGUARDANDO COMPROVANTE
        if (payment && payment.status === "awaiting_receipt") {
          console.log(`Comprovante VÁLIDO recebido de ${username}`)
          
          await sendMessage(chatId, "Comprovante recebido! Aguarde a aprovação manual.")

          if (OWNER_TELEGRAM_ID) {
            await sendMessage(OWNER_TELEGRAM_ID, `🔔 NOVO COMPROVANTE\nUsuário: @${username}\nID: ${chatId}\nPlano: ${payment.planKey} (${payment.groupKey})\n\nPara aprovar, use:\n\`/aprovar ${chatId}\``)
            
            await axios.post(`${TELEGRAM_API}/forwardMessage`, {
              chat_id: OWNER_TELEGRAM_ID,
              from_chat_id: chatId,
              message_id: message.message_id
            }).catch(e => console.error("Erro no forward:", e.message))
          }
        } else {
          console.log(`Foto ignorada de ${username} (Não solicitada pelo bot)`)
        }
      }
    }

    // Lógica de Aprovação
    if (text.startsWith("/aprovar")) {
      await handleApproval(chatId, userId, username, text)
    }

  } catch (err) {
    console.error("Erro no webhook:", err.message)
  }
})

// --- FUNÇÕES DE LÓGICA --- //

async function handleApproval(adminChatId, adminUserId, adminUsername, text) {
  if (adminUserId.toString() !== OWNER_TELEGRAM_ID) return

  const parts = text.split(" ")
  if (parts.length < 2) return await sendMessage(adminChatId, "Use: /aprovar <ID>")

  const clientId = parts[1]
  const PendingPayment = mongoose.model("PendingPayment")
  const Subscription = mongoose.model("Subscription")
  const payment = await PendingPayment.findById(clientId)

  if (!payment) return await sendMessage(adminChatId, `Pagamento não encontrado para o ID: ${clientId}`)

  const plansConfig = getPlansConfig()
  const plan = plansConfig[payment.groupKey]?.plans[payment.planKey]
  const groupId = plansConfig[payment.groupKey]?.group_id

  if (!plan || !groupId) return await sendMessage(adminChatId, "Erro: Configuração de plano/grupo não encontrada.")

  try {
    const expire = Math.floor(Date.now() / 1000) + (30 * 60)
    const r = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, {
      chat_id: groupId,
      member_limit: 1,
      expire_date: expire
    })
    const invite = r.data.result.invite_link

    const expires = new Date(Date.now() + plan.days * 86400000)
    await Subscription.findByIdAndUpdate(
      payment.userId,
      { _id: payment.userId, userId: payment.userId, chatId: clientId, groupKey: payment.groupKey, planKey: payment.planKey, expiresAt: expires, status: "active" },
      { upsert: true }
    )

    await sendMessage(clientId, "✅ Pagamento aprovado! Bem-vindo(a)!", { 
      inline_keyboard: [[{ text: "Entrar no grupo", url: invite }]] 
    })
    await PendingPayment.deleteOne({ _id: clientId })
    await sendMessage(adminChatId, `✅ Sucesso! @${payment.userName} aprovado.`)

  } catch (e) {
    console.error("Erro na aprovação:", e.message)
    await sendMessage(adminChatId, "Erro ao gerar link. Verifique as permissões do bot no grupo.")
  }
}

function getPlansConfig() {
  return {
    br: {
      group_id: VIP_BR_GROUP_ID,
      plans: {
        monthly: { label: "Mensal", price_display: "R$ 29,90", days: 30 },
        quarterly: { label: "Trimestral", price_display: "R$ 76,24", days: 90 },
        semiannual: { label: "Semestral", price_display: "R$ 134,55", days: 180 }
      }
    },
    int: {
      group_id: VIP_INT_GROUP_ID,
      plans: {
        monthly: { label: "Monthly", price_display: "$11", days: 30 },
        quarterly: { label: "Quarterly", price_display: "$28", days: 90 },
        semiannual: { label: "Semestral", price_display: "$49", days: 180 }
      }
    }
  }
}

async function sendMessage(chatId, text, reply_markup = null) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, reply_markup, parse_mode: "Markdown" }).catch(e => console.error(e.message))
}

// --- INICIALIZAÇÃO --- //

async function connectServices() {
  try {
    if (MONGODB_URI) {
      await mongoose.connect(MONGODB_URI)
      if (!mongoose.models.PendingPayment) {
        mongoose.model("PendingPayment", new mongoose.Schema({ _id: Number, userId: Number, userName: String, groupKey: String, planKey: String, status: String, timestamp: { type: Date, default: Date.now } }))
      }
      if (!mongoose.models.Subscription) {
        mongoose.model("Subscription", new mongoose.Schema({ _id: Number, userId: Number, chatId: Number, groupKey: String, planKey: String, expiresAt: Date, status: String }))
      }
      console.log("MongoDB OK")
    }
    if (WEBHOOK_BASE_URL && BOT_TOKEN) {
      await axios.get(`${TELEGRAM_API}/setWebhook?url=${WEBHOOK_BASE_URL}/telegram`)
      console.log("Webhook OK")
    }
  } catch (e) { console.error(e.message) }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor na porta ${PORT}`)
  connectServices()
})
