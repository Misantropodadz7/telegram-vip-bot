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
  res.send(`<h1>Bot Online!</h1><p>Porta: ${PORT}</p><p>Status: Ativo e aguardando Telegram.</p>`)
})

// TELEGRAM WEBHOOK
app.post("/telegram", async (req, res) => {
  console.log("--- NOVO UPDATE RECEBIDO ---")
  console.log(JSON.stringify(req.body, null, 2))

  const { message, callback_query } = req.body
  res.sendStatus(200) // Responde OK imediatamente

  try {
    const chatId = message?.chat?.id || callback_query?.message?.chat?.id
    const userId = message?.from?.id || callback_query?.from?.id
    const username = message?.from?.username || callback_query?.from?.username || "User"
    const text = message?.text || ""
    const callbackData = callback_query?.data

    // Lógica do Comando /start
    if (text.startsWith("/start")) {
      await handleStart(chatId, username, userId)
    }

    // Lógica de Planos (Callback)
    if (callbackData?.startsWith("plans_")) {
      const groupKey = callbackData.split("_")[1]
      await handlePlans(chatId, groupKey)
    }

    // Lógica de Compra (Callback)
    if (callbackData?.startsWith("buy_")) {
      const [, groupKey, planKey] = callbackData.split("_")
      await handleBuy(chatId, userId, username, groupKey, planKey)
    }

    // Recebimento de Comprovante
    if (message?.photo || message?.document) {
      await handleReceipt(chatId, username)
    }

    // Lógica de Aprovação
    if (text.startsWith("/aprovar")) {
      await handleApproval(chatId, userId, username, text)
    }

  } catch (err) {
    console.error("Erro GERAL no processamento do webhook:", err.message)
    if (OWNER_TELEGRAM_ID) {
      await notifyAdmin(`🚨 Erro crítico no bot: ${err.message}`)
    }
  }
})

// --- FUNÇÕES DE LÓGICA --- //

async function handleStart(chatId, username, userId) {
  console.log(`Processando /start para: ${username} (${userId})`)
  await sendMessage(chatId, "Escolha seu grupo VIP:", {
    inline_keyboard: [
      [{ text: "VIP BR 🇧🇷", callback_data: "plans_br" }],
      [{ text: "VIP INT 🌎", callback_data: "plans_int" }]
    ]
  })
}

async function handlePlans(chatId, groupKey) {
  const plans = getPlansConfig()[groupKey]?.plans
  if (!plans) return

  const keyboard = Object.keys(plans).map(key => ([{
    text: `${plans[key].label} - ${plans[key].price_display}`,
    callback_data: `buy_${groupKey}_${key}`
  }]))

  await sendMessage(chatId, "Escolha seu plano:", { inline_keyboard: keyboard })
}

async function handleBuy(chatId, userId, username, groupKey, planKey) {
  if (mongoose.connection.readyState !== 1) {
    return await sendMessage(chatId, "O banco de dados está conectando, tente novamente em 1 minuto.")
  }
  const PendingPayment = mongoose.model("PendingPayment")
  await PendingPayment.findByIdAndUpdate(
    chatId,
    { _id: chatId, userId, userName: username, groupKey, planKey },
    { upsert: true, new: true }
  )
  await sendMessage(chatId, "Por favor, envie o comprovante de pagamento (Foto ou PDF) aqui no chat.")
}

async function handleReceipt(chatId, username) {
  console.log(`Comprovante recebido de ${username}`)
  await notifyAdmin(`🔔 NOVO COMPROVANTE\nUsuário: @${username}\nID: ${chatId}\nUse: /aprovar ${chatId}`)
  await sendMessage(chatId, "Comprovante recebido! Aguarde a aprovação manual.")
}

async function handleApproval(adminChatId, adminUserId, adminUsername, text) {
  console.log(`Comando /aprovar recebido de ${adminUsername}`)
  if (adminUserId.toString() !== OWNER_TELEGRAM_ID) {
    return console.log(`Tentativa de aprovação por não-admin: ${adminUsername}`)
  }

  const parts = text.split(" ")
  if (parts.length < 2 || !/^[0-9]+$/.test(parts[1])) {
    return await sendMessage(adminChatId, "Formato inválido. Use: /aprovar <ID_DO_CLIENTE>")
  }

  const clientId = parseInt(parts[1])

  if (mongoose.connection.readyState !== 1) {
    return await sendMessage(adminChatId, "Banco de dados offline.")
  }

  const PendingPayment = mongoose.model("PendingPayment")
  const Subscription = mongoose.model("Subscription")
  const payment = await PendingPayment.findById(clientId)

  if (!payment) {
    return await sendMessage(adminChatId, `Nenhum pagamento pendente para o ID: ${clientId}`)
  }

  const plansConfig = getPlansConfig()
  const plan = plansConfig[payment.groupKey]?.plans[payment.planKey]
  const groupId = plansConfig[payment.groupKey]?.group_id

  if (!plan || !groupId) {
    return await notifyAdmin(`Erro: Plano ou Grupo não encontrado para ${payment.groupKey}/${payment.planKey}`)
  }

  console.log(`Gerando link para o grupo ${groupId}...`)
  const invite = await generateInvite(groupId)

  if (!invite) {
    return await sendMessage(adminChatId, `Erro ao gerar link para o cliente ${clientId}. Verifique as permissões do bot no grupo.`)
  }

  const expires = new Date(Date.now() + plan.days * 86400000)
  await Subscription.findByIdAndUpdate(
    payment.userId,
    { _id: payment.userId, userId: payment.userId, chatId: clientId, groupKey: payment.groupKey, planKey: payment.planKey, expiresAt: expires, status: "active" },
    { upsert: true, new: true }
  )

  await sendMessage(clientId, "✅ Pagamento aprovado! Bem-vindo(a)!", { inline_keyboard: [[{ text: "Entrar no grupo", url: invite }]] })
  await PendingPayment.deleteOne({ _id: clientId })
  await sendMessage(adminChatId, `✅ Pagamento de @${payment.userName} (ID: ${clientId}) aprovado!`)
}

// --- FUNÇÕES UTILITÁRIAS --- //

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
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, reply_markup })
  } catch (e) {
    console.error(`Erro ao enviar mensagem para ${chatId}:`, e.message)
  }
}

async function notifyAdmin(text) {
  if (OWNER_TELEGRAM_ID) {
    await sendMessage(OWNER_TELEGRAM_ID, text)
  }
}

async function generateInvite(groupId) {
  try {
    const expire = Math.floor(Date.now() / 1000) + (30 * 60) // 30 minutos
    const r = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, {
      chat_id: groupId,
      member_limit: 1,
      expire_date: expire
    })
    return r.data.result.invite_link
  } catch (err) {
    console.error(`Erro ao gerar link para o grupo ${groupId}:`, err.message)
    await notifyAdmin(`🚨 Falha ao gerar link para o grupo ${groupId}. O bot tem permissão de admin para criar convites?`)
    return null
  }
}

// --- INICIALIZAÇÃO --- //

async function connectServices() {
  try {
    // 1. Conectar MongoDB
    if (MONGODB_URI) {
      console.log("Conectando ao MongoDB...")
      await mongoose.connect(MONGODB_URI)
      console.log("MongoDB OK")

      // 2. Definir TODOS os Schemas e Modelos
      const pendingPaymentSchema = new mongoose.Schema({ _id: Number, userId: Number, userName: String, groupKey: String, planKey: String, timestamp: { type: Date, default: Date.now } })
      const subscriptionSchema = new mongoose.Schema({ _id: Number, userId: Number, chatId: Number, groupKey: String, planKey: String, expiresAt: Date, status: String })
      
      if (!mongoose.models.PendingPayment) mongoose.model("PendingPayment", pendingPaymentSchema)
      if (!mongoose.models.Subscription) mongoose.model("Subscription", subscriptionSchema)
      console.log("Modelos do DB definidos.")
    }

    // 3. Configurar Webhook
    if (WEBHOOK_BASE_URL && BOT_TOKEN) {
      const url = `${WEBHOOK_BASE_URL}/telegram`
      console.log(`Configurando Webhook para: ${url}`)
      const res = await axios.get(`${TELEGRAM_API}/setWebhook?url=${url}`)
      console.log("Status Webhook Telegram:", res.data.description)
    }
  } catch (e) {
    console.error("Erro CRÍTICO ao conectar serviços:", e.message)
  }
}

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`>>> SERVIDOR RODANDO EM 0.0.0.0:${PORT} <<<`)
  connectServices()
})

server.on('error', (e) => console.error("ERRO NO SERVIDOR EXPRESS:", e.message))
