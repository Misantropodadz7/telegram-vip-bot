const express = require("express")
const bodyParser = require("body-parser")
const axios = require("axios")
const mongoose = require("mongoose")
const { google } = require("googleapis")

const app = express()

// CRUCIAL: No Railway, a porta DEVE vir da variável PORT.
// Se não existir, usamos 3000 como fallback, mas o Railway sempre injeta.
const PORT = process.env.PORT || 3000

// TELEGRAM
const BOT_TOKEN = process.env.BOT_TOKEN
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

// VARIÁVEIS DE AMBIENTE (Limpando espaços em branco)
const OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID?.trim() || ""
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL?.trim() || ""
const MONGODB_URI = process.env.MONGODB_URI?.trim() || ""
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID?.trim() || ""
const VIP_BR_GROUP_ID = process.env.GROUP_ID_BR?.trim() || ""
const VIP_INT_GROUP_ID = process.env.GROUP_ID_INT?.trim() || ""

let sheetsClient = null

// MIDDLEWARES - Configuração robusta do BodyParser
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))

// ROTA DE TESTE (Para você abrir no navegador e ver se o Railway está OK)
app.get("/", (req, res) => {
  res.send(`<h1>Bot Online!</h1><p>Porta: ${PORT}</p><p>Status: Ativo e aguardando Telegram.</p>`)
})

// ROTA DE SAÚDE (Usada por alguns serviços de monitoramento)
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() })
})

// TELEGRAM WEBHOOK - O coração do Bot
app.post("/telegram", async (req, res) => {
  // Log imediato para confirmarmos no painel do Railway
  console.log("--- NOVO UPDATE RECEBIDO DO TELEGRAM ---")
  console.log(JSON.stringify(req.body, null, 2))

  const { message, callback_query } = req.body
  const callback = callback_query

  // Responde OK imediatamente para o Telegram não reenviar a mesma mensagem (evita loop)
  res.sendStatus(200)

  try {
    const chatId = message?.chat?.id || callback?.message?.chat?.id
    const userId = message?.from?.id || callback?.from?.id
    const username = message?.from?.username || callback?.from?.username || "User"
    const text = message?.text || ""

    // Lógica do Comando /start
    if (text.startsWith("/start")) {
      console.log(`Processando /start para: ${username} (${userId})`)
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "Escolha seu grupo VIP:",
        reply_markup: {
          inline_keyboard: [
            [{ text: "VIP BR 🇧🇷", callback_data: "plans_br" }],
            [{ text: "VIP INT 🌎", callback_data: "plans_int" }]
          ]
        }
      })
    }

    // Lógica de Planos (Callback Query)
    if (callback && callback.data.startsWith("plans_")) {
      const groupKey = callback.data.split("_")[1]
      const plans = {
        br: [
          { label: "Mensal", price: "R$ 29,90", key: "monthly" },
          { label: "Trimestral", price: "R$ 76,24", key: "quarterly" },
          { label: "Semestral", price: "R$ 134,55", key: "semiannual" }
        ],
        int: [
          { label: "Monthly", price: "$11", key: "monthly" },
          { label: "Quarterly", price: "$28", key: "quarterly" },
          { label: "Semiannual", price: "$49", key: "semiannual" }
        ]
      }

      const keyboard = plans[groupKey].map(p => ([{
        text: `${p.label} - ${p.price}`,
        callback_data: `buy_${groupKey}_${p.key}`
      }]))

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "Escolha seu plano:",
        reply_markup: { inline_keyboard: keyboard }
      })
    }

    // Lógica de Compra (Início do Checkout)
    if (callback && callback.data.startsWith("buy_")) {
      const [, groupKey, planKey] = callback.data.split("_")
      
      // Salva intenção de compra no Banco (se conectado)
      if (mongoose.connection.readyState === 1) {
        const PendingPayment = mongoose.model("PendingPayment")
        await PendingPayment.findByIdAndUpdate(
          chatId,
          { _id: chatId, userId, userName: username, groupKey, planKey },
          { upsert: true }
        )
      }

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "Por favor, envie o comprovante de pagamento (Foto ou PDF) aqui no chat."
      })
    }

    // Recebimento de Comprovante
    if (message?.photo || message?.document) {
      console.log(`Comprovante recebido de ${username}`)
      if (OWNER_TELEGRAM_ID) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: OWNER_TELEGRAM_ID,
          text: `🔔 NOVO COMPROVANTE\nUsuário: @${username}\nID: ${chatId}\nVerifique o chat com o bot.`
        })
      }
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "Comprovante recebido com sucesso! Aguarde a aprovação manual do administrador."
      })
    }

  } catch (err) {
    console.error("Erro no processamento do Telegram:", err.message)
  }
})

// INICIALIZAÇÃO DE BANCO E GOOGLE (Assíncrona para não travar o Railway)
async function connectServices() {
  try {
    if (MONGODB_URI) {
      console.log("Conectando ao MongoDB...")
      await mongoose.connect(MONGODB_URI)
      console.log("MongoDB OK")
      
      // Define Schemas se necessário (exemplo rápido)
      if (!mongoose.models.PendingPayment) {
        mongoose.model("PendingPayment", new mongoose.Schema({
          _id: Number, userId: Number, userName: String, groupKey: String, planKey: String, timestamp: { type: Date, default: Date.now }
        }))
      }
    }

    if (WEBHOOK_BASE_URL && BOT_TOKEN) {
      const url = `${WEBHOOK_BASE_URL}/telegram`
      console.log(`Configurando Webhook para: ${url}`)
      const res = await axios.get(`${TELEGRAM_API}/setWebhook?url=${url}`)
      console.log("Status Webhook Telegram:", res.data.description)
    }
  } catch (e) {
    console.error("Erro ao conectar serviços:", e.message)
  }
}

// INICIALIZAÇÃO DO SERVIDOR (A parte mais importante para o Erro 502)
// Ouvir em 0.0.0.0 é obrigatório.
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`>>> SERVIDOR RODANDO EM 0.0.0.0:${PORT} <<<`)
  console.log("Railway deve agora detectar a aplicação como saudável.")
  
  // Inicia as conexões pesadas DEPOIS que o servidor já está "vivo"
  connectServices()
})

// Tratamento de erros do servidor
server.on('error', (e) => {
  console.error("ERRO NO SERVIDOR EXPRESS:", e.message)
})
