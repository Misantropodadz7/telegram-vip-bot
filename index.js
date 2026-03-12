const express = require("express")
const bodyParser = require("body-parser")
const axios = require("axios")
const mongoose = require("mongoose")
const { google } = require("googleapis")
const fs = require("fs")
const path = require("path")

const app = express()
const PORT = process.env.PORT || 3000

// ─── Telegram ────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

// ─── Dados de Pagamento ───────────────────────────────────────────────────────
const TRUST_WALLET_ADDRESS = process.env.TRUST_WALLET_ADDRESS?.trim() || ""
const LIVEPIX_URL = process.env.LIVEPIX_URL?.trim() || ""
const OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID?.trim() || ""

// ─── IDs dos grupos VIP ───────────────────────────────────────────────────────
const VIP_BR_GROUP_ID = process.env.VIP_BR_GROUP_ID?.trim() || ""
const VIP_INT_GROUP_ID = process.env.VIP_INT_GROUP_ID?.trim() || ""

// ─── Outros ENVs ──────────────────────────────────────────────────────────────
const PRIVACY_PROFILE_URL = process.env.PRIVACY_PROFILE_URL?.trim() || ""
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL?.trim() || ""
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/vip_bot"
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || ""

// ─── Google Sheets Credentials ────────────────────────────────────────────────
let sheetsClient = null
let authClient = null

async function initializeGoogleSheets() {
  try {
    const keyFile = process.env.GOOGLE_CREDENTIALS_PATH || "./google-credentials.json"
    
    if (!fs.existsSync(keyFile)) {
      console.warn("⚠️ Google Sheets credentials file not found. Skipping Google Sheets integration.")
      return false
    }

    const credentials = JSON.parse(fs.readFileSync(keyFile, "utf8"))
    
    authClient = new google.auth.GoogleAuth({
      keyFile,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    })

    sheetsClient = google.sheets({ version: "v4", auth: authClient })
    console.log("✅ Google Sheets API initialized successfully")
    return true
  } catch (error) {
    console.error("❌ Error initializing Google Sheets:", error.message)
    return false
  }
}

// ─── Configuração de planos ───────────────────────────────────────────────────
const plansConfig = {
  br: {
    welcome_message: "💰 Escolha seu método de pagamento:",
    group_id: VIP_BR_GROUP_ID,
    plans: {
      monthly: { label: "Mensal", price: "29.90", price_display: "R$ 29,90", price_usd: "6", days: 30 },
      quarterly: { label: "Trimestral", price: "76.24", price_display: "R$ 76,24", price_usd: "15", days: 90 },
      semiannual: { label: "Semestral", price: "134.55", price_display: "R$ 134,55", price_usd: "33", days: 180 },
    },
  },
  int: {
    welcome_message: "💰 Choose your payment method:",
    group_id: VIP_INT_GROUP_ID,
    plans: {
      monthly: { label: "Monthly", price: "45.00", price_display: "$11", price_usd: "11", days: 30 },
      quarterly: { label: "Quarterly", price: "115.00", price_display: "$28", price_usd: "28", days: 90 },
      semiannual: { label: "Semiannual", price: "200.00", price_display: "$49", price_usd: "49", days: 180 },
    },
  },
}

// ─── Mongoose Schemas ─────────────────────────────────────────────────────────

// Schema para Pagamentos Pendentes
const pendingPaymentSchema = new mongoose.Schema({
  chatId: { type: Number, required: true, unique: true },
  userId: { type: Number, required: true },
  userName: String,
  groupKey: { type: String, enum: ["br", "int"], required: true },
  planKey: { type: String, required: true },
  amount: String,
  paymentMethod: { type: String, enum: ["crypto", "livepix"], default: null },
  timestamp: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) },
})

// Schema para Assinaturas
const subscriptionSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true, index: true },
  chatId: { type: Number, required: true },
  userName: String,
  groupKey: { type: String, enum: ["br", "int"], required: true },
  planKey: { type: String, required: true },
  activatedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ["active", "expired", "cancelled"], default: "active" },
  paymentMethod: { type: String, enum: ["crypto", "livepix"] },
  renewalCount: { type: Number, default: 0 },
})

// Schema para Histórico de Removidos
const removedUserSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  groupKey: { type: String, enum: ["br", "int"], required: true },
  removedAt: { type: Date, default: Date.now },
  reason: { type: String, default: "subscription_expired" },
})

// Schema para Logs de Transações
const transactionLogSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  action: { type: String, required: true },
  details: mongoose.Schema.Types.Mixed,
  timestamp: { type: Date, default: Date.now },
})

const PendingPayment = mongoose.model("PendingPayment", pendingPaymentSchema)
const Subscription = mongoose.model("Subscription", subscriptionSchema)
const RemovedUser = mongoose.model("RemovedUser", removedUserSchema)
const TransactionLog = mongoose.model("TransactionLog", transactionLogSchema)

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(bodyParser.json())

// ─── Google Sheets Functions ──────────────────────────────────────────────────

/**
 * Atualiza a planilha de monitoramento com dados de assinaturas
 */
async function updateMonitoringSheet() {
  if (!sheetsClient || !GOOGLE_SHEETS_ID) return

  try {
    const subscriptions = await Subscription.find({ status: "active" }).sort({ expiresAt: 1 })
    
    // Preparar dados para a planilha
    const rows = [
      ["ID do Usuário", "Nome", "Grupo", "Plano", "Ativada em", "Expira em", "Dias Restantes", "Status", "Método de Pagamento"],
    ]

    const now = Date.now()
    
    for (const sub of subscriptions) {
      const daysRemaining = Math.ceil((sub.expiresAt - now) / (24 * 60 * 60 * 1000))
      const activatedDate = new Date(sub.activatedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
      const expiresDate = new Date(sub.expiresAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
      
      rows.push([
        sub.userId.toString(),
        sub.userName || "N/A",
        sub.groupKey.toUpperCase(),
        sub.planKey,
        activatedDate,
        expiresDate,
        daysRemaining.toString(),
        sub.status,
        sub.paymentMethod || "N/A",
      ])
    }

    // Atualizar a planilha
    await sheetsClient.spreadsheets.values.clear({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: "Assinaturas!A1:I1000",
    })

    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: "Assinaturas!A1",
      valueInputOption: "RAW",
      resource: { values: rows },
    })

    console.log("✅ Google Sheets atualizado com sucesso")
  } catch (error) {
    console.error("❌ Erro ao atualizar Google Sheets:", error.message)
  }
}

/**
 * Adiciona uma linha ao histórico de removidos na planilha
 */
async function addRemovedUserToSheet(userId, groupKey, removedAt) {
  if (!sheetsClient || !GOOGLE_SHEETS_ID) return

  try {
    const values = [
      [
        userId.toString(),
        groupKey.toUpperCase(),
        new Date(removedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
      ],
    ]

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: "Removidos!A2",
      valueInputOption: "RAW",
      resource: { values },
    })

    console.log("✅ Usuário removido adicionado ao histórico da planilha")
  } catch (error) {
    console.error("❌ Erro ao adicionar usuário removido à planilha:", error.message)
  }
}

// ─── Verificar e remover assinaturas expiradas ────────────────────────────────

async function checkAndRemoveExpiredSubscriptions() {
  try {
    const now = Date.now()
    
    // Encontrar assinaturas expiradas
    const expiredSubscriptions = await Subscription.find({
      expiresAt: { $lte: new Date(now) },
      status: "active",
    })

    for (const subscription of expiredSubscriptions) {
      try {
        const groupId = plansConfig[subscription.groupKey].group_id
        
        // Remover usuário do grupo
        const removed = await removeUserFromGroup(groupId, subscription.userId)
        
        if (removed) {
          // Atualizar status no banco de dados
          subscription.status = "expired"
          await subscription.save()

          // Registrar remoção
          await RemovedUser.create({
            userId: subscription.userId,
            groupKey: subscription.groupKey,
            removedAt: new Date(),
            reason: "subscription_expired",
          })

          // Adicionar ao histórico da planilha
          await addRemovedUserToSheet(subscription.userId, subscription.groupKey, new Date())

          // Notificar usuário e proprietário
          await notifyUserSubscriptionExpired(subscription.userId, subscription.groupKey)
          await notifyOwnerUserRemoved(subscription.userId, subscription.groupKey)

          // Registrar log
          await TransactionLog.create({
            userId: subscription.userId,
            action: "subscription_expired_and_removed",
            details: {
              groupKey: subscription.groupKey,
              planKey: subscription.planKey,
              expiresAt: subscription.expiresAt,
            },
          })

          console.log(`✅ Usuário ${subscription.userId} removido por expiração de assinatura`)
        }
      } catch (error) {
        console.error(`❌ Erro ao remover usuário ${subscription.userId}:`, error.message)
      }
    }

    // Atualizar planilha de monitoramento
    if (expiredSubscriptions.length > 0) {
      await updateMonitoringSheet()
    }
  } catch (error) {
    console.error("❌ Erro ao verificar assinaturas expiradas:", error.message)
  }
}

/**
 * Remove um usuário de um grupo Telegram
 */
async function removeUserFromGroup(groupId, userId) {
  try {
    const response = await axios.post(`${TELEGRAM_API}/kickChatMember`, {
      chat_id: groupId,
      user_id: userId,
      revoke_messages: false,
    })
    return response.data.ok
  } catch (error) {
    console.error(`Erro ao remover usuário ${userId}:`, error.message)
    return false
  }
}

/**
 * Notifica o usuário que sua assinatura expirou
 */
async function notifyUserSubscriptionExpired(userId, groupKey) {
  try {
    const message = groupKey === "br"
      ? `⏰ *Sua assinatura VIP expirou!*\n\n😢 Infelizmente, sua assinatura chegou ao fim e você foi removido do grupo VIP.\n\n💡 Para continuar com acesso, use /start para renovar sua assinatura.`
      : `⏰ *Your VIP subscription has expired!*\n\n😢 Unfortunately, your subscription has ended and you have been removed from the VIP group.\n\n💡 To continue with access, use /start to renew your subscription.`

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: userId,
      text: message,
      parse_mode: "Markdown",
    })
  } catch (error) {
    console.error(`Erro ao notificar usuário ${userId}:`, error.message)
  }
}

/**
 * Notifica o proprietário sobre a remoção de um usuário
 */
async function notifyOwnerUserRemoved(userId, groupKey) {
  try {
    const message = `🔔 *Usuário removido por expiração*\n\n👤 ID: ${userId}\n🏠 Grupo: ${groupKey.toUpperCase()}\n⏰ Removido em: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: OWNER_TELEGRAM_ID,
      text: message,
      parse_mode: "Markdown",
    })
  } catch (error) {
    console.error(`Erro ao notificar proprietário:`, error.message)
  }
}

/**
 * Inicia o monitoramento periódico de assinaturas
 */
function startSubscriptionMonitoring() {
  console.log("🔍 Monitoramento de assinaturas iniciado (verificação a cada 5 minutos)")
  
  checkAndRemoveExpiredSubscriptions()
  
  setInterval(() => {
    checkAndRemoveExpiredSubscriptions()
  }, 5 * 60 * 1000)
}

// ─── Webhook do Telegram ──────────────────────────────────────────────────────
app.post("/telegram", async (req, res) => {
  const { message, callback_query: callback } = req.body

  if (!message && !callback) return res.sendStatus(200)

  try {
    const chatId = message?.chat.id || callback?.message.chat.id
    const userId = message?.from.id || callback?.from.id
    const userName = message?.from.username || callback?.from.username || "User"

    // ─── Comando /start ───────────────────────────────────────────────────────
    if (message?.text === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "🎯 Welcome! Choose your VIP group:",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🇧🇷 VIP BRASIL", callback_data: "show_plans_br" }],
            [{ text: "🌍 VIP INTERNATIONAL", callback_data: "show_plans_int" }],
            [{ text: "👤 My Privacy", url: PRIVACY_PROFILE_URL }],
            [{ text: "ℹ️ Information", callback_data: "show_info" }],
          ],
        },
      })
    }

    // ─── Mostrar informações ──────────────────────────────────────────────────
    if (callback && callback.data === "show_info") {
      const infoText = `⏰ *CONFIRMATION HOURS*\n\n🕘 Daily: 09:00 - 22:00\n(Brasília Time)\n\nPayments sent outside these hours will be confirmed during business hours.\n\n💙 Thank you for your understanding!`
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: infoText,
        parse_mode: "Markdown",
      })
    }

    // ─── Mostrar planos ───────────────────────────────────────────────────────
    if (callback && callback.data.startsWith("show_plans_")) {
      const groupKey = callback.data.split("_")[2]
      const config = plansConfig[groupKey]

      const keyboard = Object.keys(config.plans).map((planKey) => {
        const plan = config.plans[planKey]
        return [
          {
            text: `💳 ${plan.label} - ${plan.price_display}`,
            callback_data: `buy_${groupKey}_${planKey}`,
          },
        ]
      })

      const welcomeText = groupKey === "br"
        ? `✨ Escolha seu plano VIP ${groupKey.toUpperCase()}:\n\n⚡ Pagamento seguro\n✅ Acesso liberado após confirmação\n⏰ Confirmações: Diariamente 09:00 - 22:00`
        : `✨ Choose your VIP plan:\n\n⚡ Secure payment\n✅ Access released after confirmation\n⏰ Confirmations: Daily 09:00 - 22:00`

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: welcomeText,
        reply_markup: { inline_keyboard: keyboard },
      })
    }

    // ─── Processar compra ─────────────────────────────────────────────────────
    if (callback && callback.data.startsWith("buy_")) {
      const [, groupKey, planKey] = callback.data.split("_")
      const config = plansConfig[groupKey]
      const plan = config.plans[planKey]

      // Armazenar pagamento pendente no banco de dados
      await PendingPayment.findByIdAndUpdate(
        chatId,
        {
          chatId,
          userId,
          userName,
          groupKey,
          planKey,
          amount: plan.price,
          timestamp: new Date(),
        },
        { upsert: true }
      )

      // Registrar log
      await TransactionLog.create({
        userId,
        action: "plan_selected",
        details: { groupKey, planKey, amount: plan.price },
      })

      const paymentMethodText = groupKey === "br"
        ? `${config.welcome_message}\n\n💰 Plano: *${plan.label}*\n💵 Valor: *${plan.price_display}*\n\nEscolha como deseja pagar:`
        : `${config.welcome_message}\n\n💰 Plan: *${plan.label}*\n💵 Amount: *${plan.price_display}*\n\nChoose how you want to pay:`

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: paymentMethodText,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: groupKey === "br" ? "💎 Cripto (USDT/TRON)" : "💎 Crypto (USDT/TRON)", callback_data: `pay_crypto_${groupKey}_${planKey}` }],
            [{ text: "💳 LivePix", callback_data: `pay_livepix_${groupKey}_${planKey}` }],
          ],
        },
      })
    }

    // ─── Pagamento com Cripto ─────────────────────────────────────────────────
    if (callback && callback.data.startsWith("pay_crypto_")) {
      const [, , groupKey, planKey] = callback.data.split("_")
      const config = plansConfig[groupKey]
      const plan = config.plans[planKey]

      const payment = await PendingPayment.findById(chatId)
      if (!payment) {
        const expiredMsg = groupKey === "br"
          ? "❌ Sessão expirada. Use /start para começar novamente."
          : "❌ Session expired. Use /start to begin again."
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: expiredMsg,
        })
      }

      payment.paymentMethod = "crypto"
      await payment.save()

      const cryptoMessage = groupKey === "br"
        ? `💎 *Pagamento em Cripto*\n\n📍 Rede: *TRON (TRX)*\n💰 Moeda: *USDT*\n💵 Valor: *${plan.price_usd} USDT*\n\n📋 *Endereço da Carteira:*\n\`${TRUST_WALLET_ADDRESS}\`\n\n⏱️ *Após enviar a criptomoeda, envie o comprovante aqui*`
        : `💎 *Crypto Payment*\n\n📍 Network: *TRON (TRX)*\n💰 Currency: *USDT*\n💵 Amount: *${plan.price_usd} USDT*\n\n📋 *Wallet Address:*\n\`${TRUST_WALLET_ADDRESS}\`\n\n⏱️ *After sending the cryptocurrency, send the receipt here*`

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: cryptoMessage,
        parse_mode: "Markdown",
      })

      const notifyMsg = groupKey === "br"
        ? `🔔 Novo pagamento pendente (CRIPTO)!\n\n💰 Valor: ${plan.price_usd} USDT\n📦 Plano: ${plan.label}\n🏠 Grupo: ${groupKey.toUpperCase()}`
        : `🔔 New pending payment (CRYPTO)!\n\n💰 Amount: ${plan.price_usd} USDT\n📦 Plan: ${plan.label}\n🏠 Group: ${groupKey.toUpperCase()}`

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: OWNER_TELEGRAM_ID,
        text: notifyMsg,
      })
    }

    // ─── Pagamento com LivePix ────────────────────────────────────────────────
    if (callback && callback.data.startsWith("pay_livepix_")) {
      const [, , groupKey, planKey] = callback.data.split("_")
      const config = plansConfig[groupKey]
      const plan = config.plans[planKey]

      const payment = await PendingPayment.findById(chatId)
      if (!payment) {
        const expiredMsg = groupKey === "br"
          ? "❌ Sessão expirada. Use /start para começar novamente."
          : "❌ Session expired. Use /start to begin again."
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: expiredMsg,
        })
      }

      payment.paymentMethod = "livepix"
      await payment.save()

      const livepixMessage = groupKey === "br"
        ? `💳 *Pagamento via LivePix*\n\n💵 Valor: *${plan.price_display}*\n\n👇 Clique no botão abaixo para pagar:`
        : `💳 *Payment via LivePix*\n\n💵 Amount: *${plan.price_display}*\n\n👇 Click the button below to pay:`

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: livepixMessage,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: groupKey === "br" ? "💳 Pagar com LivePix" : "💳 Pay with LivePix", url: LIVEPIX_URL }],
          ],
        },
      })

      const confirmMessage = groupKey === "br"
        ? `⏱️ *Após fazer o pagamento, envie o comprovante aqui*`
        : `⏱️ *After making the payment, send the receipt here*`

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: confirmMessage,
        parse_mode: "Markdown",
      })

      const notifyMsg = groupKey === "br"
        ? `🔔 Novo pagamento pendente (LIVEPIX)!\n\n💰 Valor: ${plan.price_display}\n📦 Plano: ${plan.label}\n🏠 Grupo: ${groupKey.toUpperCase()}`
        : `🔔 New pending payment (LIVEPIX)!\n\n💰 Amount: ${plan.price_display}\n📦 Plan: ${plan.label}\n🏠 Group: ${groupKey.toUpperCase()}`

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: OWNER_TELEGRAM_ID,
        text: notifyMsg,
      })
    }

    // ─── Receber comprovante ──────────────────────────────────────────────────
    if (message?.photo || message?.document) {
      const payment = await PendingPayment.findById(chatId)

      if (!payment) {
        const noPaymentMsg = "❌ Nenhum pagamento pendente encontrado. Use /start para começar."
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: noPaymentMsg,
        })
      }

      let fileId
      if (message.photo) {
        fileId = message.photo[message.photo.length - 1].file_id
      } else if (message.document) {
        fileId = message.document.file_id
      }

      const groupConfig = plansConfig[payment.groupKey]
      const plan = groupConfig.plans[payment.planKey]
      const paymentMethodText = payment.paymentMethod === "crypto" ? "💎 CRYPTO" : "💳 LIVEPIX"

      const notifyMsg = payment.groupKey === "br"
        ? `✅ Comprovante recebido!\n\n💰 Valor: ${payment.paymentMethod === "crypto" ? plan.price_usd + " USDT" : plan.price_display}\n📦 Plano: ${plan.label}\n🏠 Grupo: ${payment.groupKey.toUpperCase()}\n💳 Método: ${paymentMethodText}`
        : `✅ Receipt received!\n\n💰 Amount: ${payment.paymentMethod === "crypto" ? plan.price_usd + " USDT" : plan.price_display}\n📦 Plan: ${plan.label}\n🏠 Group: ${payment.groupKey.toUpperCase()}\n💳 Method: ${paymentMethodText}`

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: OWNER_TELEGRAM_ID,
        text: notifyMsg,
      })

      if (message.photo) {
        await axios.post(`${TELEGRAM_API}/sendPhoto`, {
          chat_id: OWNER_TELEGRAM_ID,
          photo: fileId,
          caption: `Receipt from @${payment.userName}`,
        })
      } else if (message.document) {
        await axios.post(`${TELEGRAM_API}/sendDocument`, {
          chat_id: OWNER_TELEGRAM_ID,
          document: fileId,
          caption: `Receipt from @${payment.userName}`,
        })
      }

      const receiptMsg = payment.groupKey === "br"
        ? "✅ Comprovante recebido!\n\nEstou verificando o pagamento. Você receberá o link de acesso durante o horário de confirmação."
        : "✅ Receipt received!\n\nI'm verifying the payment. You will receive the access link during confirmation hours."

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: receiptMsg,
      })
    }

    // ─── Comando /aprovar ─────────────────────────────────────────────────────
    if (message?.text?.startsWith("/aprovar") || message?.text?.startsWith("/approve")) {
      if (userId.toString() !== OWNER_TELEGRAM_ID) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ You don't have permission to use this command.",
        })
      }

      const parts = message.text.split(" ")
      const clientChatId = parseInt(parts[1])

      if (!clientChatId) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Use: /aprovar <CLIENT_ID> or /approve <CLIENT_ID>",
        })
      }

      const payment = await PendingPayment.findById(clientChatId)
      if (!payment) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Payment not found.",
        })
      }

      const groupConfig = plansConfig[payment.groupKey]
      const plan = groupConfig.plans[payment.planKey]

      const inviteLink = await generateOneTimeInviteLink(groupConfig.group_id)
      if (!inviteLink) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Error generating access link.",
        })
      }

      // Criar assinatura no banco de dados
      const expiresAt = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000)
      
      await Subscription.findByIdAndUpdate(
        payment.userId,
        {
          userId: payment.userId,
          chatId: clientChatId,
          userName: payment.userName,
          groupKey: payment.groupKey,
          planKey: payment.planKey,
          activatedAt: new Date(),
          expiresAt,
          status: "active",
          paymentMethod: payment.paymentMethod,
          renewalCount: 0,
        },
        { upsert: true }
      )

      // Remover do histórico de removidos se estava lá
      await RemovedUser.deleteOne({ userId: payment.userId })

      // Registrar log
      await TransactionLog.create({
        userId: payment.userId,
        action: "subscription_activated",
        details: {
          groupKey: payment.groupKey,
          planKey: payment.planKey,
          expiresAt,
          paymentMethod: payment.paymentMethod,
        },
      })

      const approvalMsg = payment.groupKey === "br"
        ? `✅ *Pagamento aprovado!*\n\n💎 Sua assinatura foi ativada.\n📅 Válida por ${plan.days} dias.\n⏰ Acesso confirmado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n\nClique no botão abaixo para entrar no grupo VIP:`
        : `✅ *Payment approved!*\n\n💎 Your subscription has been activated.\n📅 Valid for ${plan.days} days.\n⏰ Access confirmed on ${new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })}\n\nClick the button below to enter the VIP group:`

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: clientChatId,
        text: approvalMsg,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: payment.groupKey === "br" ? "🚀 Entrar no Grupo VIP" : "🚀 Enter VIP Group", url: inviteLink }],
          ],
        },
      })

      const confirmMsg = payment.groupKey === "br"
        ? `✅ Acesso liberado para @${payment.userName}!\n\n⏰ Assinatura válida até: ${expiresAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`
        : `✅ Access released for @${payment.userName}!\n\n⏰ Subscription valid until: ${expiresAt.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })}`

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: confirmMsg,
      })

      await PendingPayment.deleteOne({ _id: clientChatId })

      // Atualizar planilha
      await updateMonitoringSheet()
    }

    // ─── Comando /rejeitar ────────────────────────────────────────────────────
    if (message?.text?.startsWith("/rejeitar") || message?.text?.startsWith("/reject")) {
      if (userId.toString() !== OWNER_TELEGRAM_ID) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ You don't have permission to use this command.",
        })
      }

      const parts = message.text.split(" ")
      const clientChatId = parseInt(parts[1])
      const reason = parts.slice(2).join(" ") || (message.text.startsWith("/rejeitar") ? "Comprovante inválido" : "Invalid receipt")

      if (!clientChatId) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Use: /rejeitar <CLIENT_ID> <reason> or /reject <CLIENT_ID> <reason>",
        })
      }

      const payment = await PendingPayment.findById(clientChatId)
      if (!payment) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Payment not found.",
        })
      }

      const rejectMsg = payment.groupKey === "br"
        ? `❌ Seu pagamento foi rejeitado.\n\n📝 Motivo: ${reason}\n\nTente novamente com /start`
        : `❌ Your payment has been rejected.\n\n📝 Reason: ${reason}\n\nTry again with /start`

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: clientChatId,
        text: rejectMsg,
      })

      const confirmMsg = payment.groupKey === "br"
        ? `✅ Pagamento rejeitado para @${payment.userName}.`
        : `✅ Payment rejected for @${payment.userName}.`

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: confirmMsg,
      })

      // Registrar log
      await TransactionLog.create({
        userId: payment.userId,
        action: "payment_rejected",
        details: { reason },
      })

      await PendingPayment.deleteOne({ _id: clientChatId })
    }

    // ─── Comando /status ──────────────────────────────────────────────────────
    if (message?.text === "/status") {
      const subscription = await Subscription.findById(userId)
      
      if (!subscription || subscription.status !== "active") {
        const noSubMsg = "❌ Você não possui uma assinatura ativa. Use /start para adquirir uma."
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: noSubMsg,
        })
      }

      const now = Date.now()
      const timeRemaining = subscription.expiresAt - now
      const daysRemaining = Math.ceil(timeRemaining / (24 * 60 * 60 * 1000))
      const expiresAtDate = new Date(subscription.expiresAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })

      const statusMsg = `✅ *Sua Assinatura VIP*\n\n🏠 Grupo: ${subscription.groupKey.toUpperCase()}\n📅 Dias restantes: ${daysRemaining}\n⏰ Expira em: ${expiresAtDate}`

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: statusMsg,
        parse_mode: "Markdown",
      })
    }

    // ─── Comando /listar_assinaturas ──────────────────────────────────────────
    if (message?.text === "/listar_assinaturas" || message?.text === "/list_subscriptions") {
      if (userId.toString() !== OWNER_TELEGRAM_ID) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ You don't have permission to use this command.",
        })
      }

      const subscriptions = await Subscription.find({ status: "active" }).sort({ expiresAt: 1 })

      if (subscriptions.length === 0) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "📭 Nenhuma assinatura ativa no momento.",
        })
      }

      let listMsg = "📋 *Assinaturas Ativas*\n\n"
      const now = Date.now()

      for (const sub of subscriptions) {
        const daysRemaining = Math.ceil((sub.expiresAt - now) / (24 * 60 * 60 * 1000))
        listMsg += `👤 ID: ${sub.userId}\n🏠 Grupo: ${sub.groupKey.toUpperCase()}\n📅 Dias: ${daysRemaining}\n\n`
      }

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: listMsg,
        parse_mode: "Markdown",
      })
    }

    res.sendStatus(200)
  } catch (error) {
    console.error("Erro Telegram:", error.message)
    res.sendStatus(200)
  }
})

/**
 * Gera um link de convite único para o grupo
 */
async function generateOneTimeInviteLink(groupId) {
  try {
    const expireDate = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
    const response = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, {
      chat_id: groupId,
      member_limit: 1,
      expire_date: expireDate,
    })
    return response.data?.result?.invite_link
  } catch (err) {
    console.error("Erro ao gerar link de convite:", err.message)
    return null
  }
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  const subscriptionsCount = await Subscription.countDocuments({ status: "active" })
  
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    telegram_configured: !!BOT_TOKEN,
    payments_configured: !!(TRUST_WALLET_ADDRESS && LIVEPIX_URL),
    database_connected: mongoose.connection.readyState === 1,
    active_subscriptions: subscriptionsCount,
    monitoring_enabled: true,
    google_sheets_enabled: !!sheetsClient,
  })
})

// ─── Iniciar servidor ─────────────────────────────────────────────────────────
async function startServer() {
  try {
    // Conectar ao MongoDB
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    })
    console.log("✅ MongoDB conectado com sucesso")

    // Inicializar Google Sheets
    await initializeGoogleSheets()

    // Iniciar servidor Express
    app.listen(PORT, () => {
      console.log(`🚀 Bot Telegram VIP rodando na porta ${PORT}`)
      console.log(`📍 Webhook URL: ${WEBHOOK_BASE_URL}/telegram`)
      console.log(`✅ Telegram configurado: ${!!BOT_TOKEN}`)
      console.log(`✅ Cripto configurado: ${!!TRUST_WALLET_ADDRESS}`)
      console.log(`✅ LivePix configurado: ${!!LIVEPIX_URL}`)
      console.log(`✅ MongoDB conectado: ${MONGODB_URI}`)
      console.log(`✅ Google Sheets ID: ${GOOGLE_SHEETS_ID}`)
      
      // Iniciar monitoramento de assinaturas
      startSubscriptionMonitoring()
    })
  } catch (error) {
    console.error("❌ Erro ao iniciar servidor:", error.message)
    process.exit(1)
  }
}

startServer()
