const express = require("express")
const bodyParser = require("body-parser")
const axios = require("axios")

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
      monthly: { label: "Monthly", price: "45.00", price_display: "R$ 45,00", price_usd: "11", days: 30 },
      quarterly: { label: "Quarterly", price: "115.00", price_display: "R$ 115,00", price_usd: "28", days: 90 },
      semiannual: { label: "Semiannual", price: "200.00", price_display: "R$ 200,00", price_usd: "49", days: 180 },
    },
  },
}

// ─── Armazenamento em memória ──────────────────────────────────────────────────
const pendingPayments = new Map()
const userSubscriptions = new Map()

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(bodyParser.json())

// ─── Webhook do Telegram ──────────────────────────────────────────────────────
app.post("/telegram", async (req, res) => {
  const { message, callback_query: callback } = req.body

  if (!message && !callback) return res.sendStatus(200)

  try {
    const chatId = message?.chat.id || callback?.message.chat.id
    const userId = message?.from.id || callback?.from.id
    const userName = message?.from.username || callback?.from.username || "Usuário"

    // ─── Comando /start ───────────────────────────────────────────────────────
    if (message?.text === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "🎯 Bem-vindo(a)! Escolha seu grupo VIP:",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🇧🇷 VIP BRASIL", callback_data: "show_plans_br" }],
            [{ text: "🌍 VIP INTERNACIONAL", callback_data: "show_plans_int" }],
            [{ text: "👤 Meu Privacy", url: PRIVACY_PROFILE_URL }],
          ],
        },
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

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `✨ Escolha seu plano VIP ${groupKey.toUpperCase()}:\n\n⚡ Pagamento seguro\n✅ Acesso liberado após confirmação`,
        reply_markup: { inline_keyboard: keyboard },
      })
    }

    // ─── Processar compra (escolher método de pagamento) ─────────────────────
    if (callback && callback.data.startsWith("buy_")) {
      const [, groupKey, planKey] = callback.data.split("_")
      const config = plansConfig[groupKey]
      const plan = config.plans[planKey]

      // Armazenar pagamento pendente
      pendingPayments.set(chatId, {
        groupKey,
        planKey,
        amount: plan.price,
        timestamp: Date.now(),
        userName,
        userId,
      })

      // Perguntar método de pagamento
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `${config.welcome_message}\n\n💰 Plano: *${plan.label}*\n💵 Valor: *${plan.price_display}*\n\nEscolha como deseja pagar:`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "💎 Cripto (USDT/TRON)", callback_data: `pay_crypto_${groupKey}_${planKey}` }],
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

      const payment = pendingPayments.get(chatId)
      if (!payment) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Sessão expirada. Use /start para começar novamente.",
        })
      }

      // Atualizar método de pagamento
      payment.paymentMethod = "crypto"
      payment.amount_usd = plan.price_usd
      pendingPayments.set(chatId, payment)

      // Enviar endereço da Trust Wallet
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `💎 *Pagamento em Cripto*\n\n📍 Rede: *TRON (TRX)*\n💰 Moeda: *USDT*\n💵 Valor: *${plan.price_usd} USDT*\n\n📋 *Endereço da Carteira:*\n\`${TRUST_WALLET_ADDRESS}\`\n\n⏱️ *Após enviar a criptomoeda, envie o comprovante aqui* (screenshot do hash da transação)\n\nEu vou verificar e liberar seu acesso em até 5 minutos.`,
        parse_mode: "Markdown",
      })

      // Notificar o proprietário
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: OWNER_TELEGRAM_ID,
        text: `🔔 Novo pagamento pendente (CRIPTO)!\n\n💰 Valor: ${plan.price_usd} USDT\n📦 Plano: ${plan.label}\n🏠 Grupo: ${payment.groupKey.toUpperCase()}\n\nAguardando comprovante...`,
      })
    }

    // ─── Pagamento com LivePix ────────────────────────────────────────────────
    if (callback && callback.data.startsWith("pay_livepix_")) {
      const [, , groupKey, planKey] = callback.data.split("_")
      const config = plansConfig[groupKey]
      const plan = config.plans[planKey]

      const payment = pendingPayments.get(chatId)
      if (!payment) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Sessão expirada. Use /start para começar novamente.",
        })
      }

      // Atualizar método de pagamento
      payment.paymentMethod = "livepix"
      pendingPayments.set(chatId, payment)

      // Enviar link do LivePix
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `💳 *Pagamento via LivePix*\n\n💵 Valor: *${plan.price_display}*\n\n👇 Clique no botão abaixo para pagar:`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "💳 Pagar com LivePix", url: LIVEPIX_URL }],
          ],
        },
      })

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `⏱️ *Após fazer o pagamento, envie o comprovante aqui* (screenshot ou foto)\n\nEu vou verificar e liberar seu acesso em até 5 minutos.`,
        parse_mode: "Markdown",
      })

      // Notificar o proprietário
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: OWNER_TELEGRAM_ID,
        text: `🔔 Novo pagamento pendente (LIVEPIX)!\n\n💰 Valor: ${plan.price_display}\n📦 Plano: ${plan.label}\n🏠 Grupo: ${payment.groupKey.toUpperCase()}\n\nAguardando comprovante...`,
      })
    }

    // ─── Receber comprovante ──────────────────────────────────────────────────
    if (message?.photo || message?.document) {
      const payment = pendingPayments.get(chatId)

      if (!payment) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Nenhum pagamento pendente encontrado. Use /start para começar.",
        })
      }

      // Extrair informações do arquivo
      let fileId, fileName
      if (message.photo) {
        fileId = message.photo[message.photo.length - 1].file_id
        fileName = `comprovante_${chatId}_${Date.now()}.jpg`
      } else if (message.document) {
        fileId = message.document.file_id
        fileName = message.document.file_name || `comprovante_${chatId}_${Date.now()}`
      }

      // Notificar o proprietário com o comprovante
      const groupConfig = plansConfig[payment.groupKey]
      const plan = groupConfig.plans[payment.planKey]
      const paymentMethodText = payment.paymentMethod === "crypto" ? "💎 CRIPTO" : "💳 LIVEPIX"

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: OWNER_TELEGRAM_ID,
        text: `✅ Comprovante recebido!\n\n💰 Valor: ${payment.paymentMethod === "crypto" ? plan.price_usd + " USDT" : plan.price_display}\n📦 Plano: ${plan.label}\n🏠 Grupo: ${payment.groupKey.toUpperCase()}\n💳 Método: ${paymentMethodText}\n\n👇 Comprovante abaixo:`,
      })

      // Enviar o comprovante para o proprietário
      if (message.photo) {
        await axios.post(`${TELEGRAM_API}/sendPhoto`, {
          chat_id: OWNER_TELEGRAM_ID,
          photo: fileId,
          caption: `Comprovante de @${payment.userName}`,
        })
      } else if (message.document) {
        await axios.post(`${TELEGRAM_API}/sendDocument`, {
          chat_id: OWNER_TELEGRAM_ID,
          document: fileId,
          caption: `Comprovante de @${payment.userName}`,
        })
      }

      // Informar ao cliente que o comprovante foi recebido
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "✅ Comprovante recebido!\n\nEstou verificando o pagamento. Você receberá o link de acesso em breve.",
      })
    }

    // ─── Comando /aprovar ─────────────────────────────────────────────────────
    if (message?.text?.startsWith("/aprovar")) {
      if (userId.toString() !== OWNER_TELEGRAM_ID) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Você não tem permissão para usar este comando.",
        })
      }

      const parts = message.text.split(" ")
      const clientChatId = parts[1]

      if (!clientChatId) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Use: /aprovar <ID_DO_CLIENTE>",
        })
      }

      const payment = pendingPayments.get(parseInt(clientChatId))
      if (!payment) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Pagamento não encontrado.",
        })
      }

      const groupConfig = plansConfig[payment.groupKey]
      const plan = groupConfig.plans[payment.planKey]

      // Gerar link de acesso único
      const inviteLink = await generateOneTimeInviteLink(groupConfig.group_id)
      if (!inviteLink) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Erro ao gerar link de acesso.",
        })
      }

      // Armazenar assinatura
      const expiresAt = Date.now() + plan.days * 24 * 60 * 60 * 1000
      userSubscriptions.set(parseInt(clientChatId), {
        groupKey: payment.groupKey,
        expiresAt,
      })

      // Enviar link para o cliente
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: parseInt(clientChatId),
        text: `✅ *Pagamento aprovado!*\n\n💎 Sua assinatura foi ativada.\n📅 Válida por ${plan.days} dias.\n\nClique no botão abaixo para entrar no grupo VIP. O link é de uso único:`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🚀 Entrar no Grupo VIP", url: inviteLink }],
          ],
        },
      })

      // Confirmar para o proprietário
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `✅ Acesso liberado para @${payment.userName}!`,
      })

      pendingPayments.delete(parseInt(clientChatId))
    }

    // ─── Comando /rejeitar ────────────────────────────────────────────────────
    if (message?.text?.startsWith("/rejeitar")) {
      if (userId.toString() !== OWNER_TELEGRAM_ID) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Você não tem permissão para usar este comando.",
        })
      }

      const parts = message.text.split(" ")
      const clientChatId = parts[1]
      const reason = parts.slice(2).join(" ") || "Comprovante inválido"

      if (!clientChatId) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Use: /rejeitar <ID_DO_CLIENTE> <motivo>",
        })
      }

      const payment = pendingPayments.get(parseInt(clientChatId))
      if (!payment) {
        return await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Pagamento não encontrado.",
        })
      }

      // Informar ao cliente
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: parseInt(clientChatId),
        text: `❌ Seu pagamento foi rejeitado.\n\n📝 Motivo: ${reason}\n\nTente novamente com /start`,
      })

      // Confirmar para o proprietário
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `✅ Pagamento rejeitado para @${payment.userName}.`,
      })

      pendingPayments.delete(parseInt(clientChatId))
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
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    telegram_configured: !!BOT_TOKEN,
    payments_configured: !!(TRUST_WALLET_ADDRESS && LIVEPIX_URL),
  })
})

// ─── Iniciar servidor ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Bot Telegram VIP (Cripto + LivePix) rodando na porta ${PORT}`)
  console.log(`📍 Webhook URL: ${WEBHOOK_BASE_URL}/telegram`)
  console.log(`✅ Telegram configurado: ${!!BOT_TOKEN}`)
  console.log(`✅ Cripto configurado: ${!!TRUST_WALLET_ADDRESS}`)
  console.log(`✅ LivePix configurado: ${!!LIVEPIX_URL}`)
})


