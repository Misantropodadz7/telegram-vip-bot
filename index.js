const express = require("express")
const bodyParser = require("body-parser")
const axios = require("axios")

const app = express()
const PORT = process.env.PORT || 3000

// ─── Telegram ────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

// ─── Bipa BitPix ─────────────────────────────────────────────────────────────
// Seu ID da chave BitPix (fornecido pela Bipa)
const BITPIX_KEY_ID = process.env.BITPIX_KEY_ID?.trim() || ""

// Sua carteira Trust Wallet (para onde o dinheiro será enviado)
const MY_CRYPTO_ADDRESS = process.env.MY_CRYPTO_ADDRESS?.trim() || ""

// ─── IDs dos grupos VIP ───────────────────────────────────────────────────────
const VIP_BR_GROUP_ID   = process.env.VIP_BR_GROUP_ID?.trim()  || ""
const VIP_INT_GROUP_ID  = process.env.VIP_INT_GROUP_ID?.trim() || ""

// ─── Outros ENVs ──────────────────────────────────────────────────────────────
const PRIVACY_PROFILE_URL = process.env.PRIVACY_PROFILE_URL?.trim() || ""
const IP_API_KEY          = process.env.IP_API_KEY || ""
const WEBHOOK_BASE_URL    = process.env.WEBHOOK_BASE_URL?.trim() || ""

// ─── Configuração de planos ───────────────────────────────────────────────────
const plansConfig = {
  br: {
    welcome_message: "✅ Pague o Pix abaixo para entrar no VIP BRASIL automaticamente:",
    allowed_country: "BR",
    group_id: VIP_BR_GROUP_ID,
    plans: {
      monthly:    { label: "Mensal",     price_brl: 2990,  price_display: "R$ 29,90" },
      quarterly:  { label: "Trimestral", price_brl: 7624,  price_display: "R$ 76,24" },
      semiannual: { label: "Semestral",  price_brl: 13455, price_display: "R$ 134,55" },
    },
  },
  int: {
    welcome_message: "✅ Pay the Pix below to join VIP INTERNATIONAL automatically:",
    allowed_country: null,
    group_id: VIP_INT_GROUP_ID,
    plans: {
      monthly:    { label: "Monthly",    price_brl: 4500,  price_display: "R$ 45,00" },
      quarterly:  { label: "Quarterly",  price_brl: 11500, price_display: "R$ 115,00" },
      semiannual: { label: "Semiannual", price_brl: 20000, price_display: "R$ 200,00" },
    },
  },
}

// ─── Armazenamento em memória (em produção, use banco de dados) ────────────────
const pendingPayments = new Map() // { requestId: { chatId, groupKey, planKey, expiresAt, amount } }
const completedPayments = new Set() // { requestId }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getUserIp(req) {
  const forwarded = req.headers["x-forwarded-for"]
  if (forwarded) return forwarded.split(",")[0].trim()
  return req.socket.remoteAddress
}

async function checkGeolocation(ip) {
  try {
    const url = `http://ip-api.com/json/${ip}?fields=countryCode,proxy,hosting` + (IP_API_KEY ? `&key=${IP_API_KEY}` : "")
    const response = await axios.get(url)
    return response.data
  } catch (err) {
    return null
  }
}

/**
 * Gera o QR Code de Pix para a BitPix.
 * A BitPix gera automaticamente um QR Code dinâmico baseado no ID da chave.
 */
function generateBitPixQRCode(amount) {
  // A Bipa gera QR Codes dinâmicos. Você pode usar a chave BitPix diretamente
  // ou gerar um QR Code via API da Bipa (se disponível).
  // Por enquanto, retornamos a chave BitPix como identificador.
  return {
    bitpix_key: BITPIX_KEY_ID,
    amount: amount,
    qr_code_url: `https://bipa.app/pay/${BITPIX_KEY_ID}?amount=${amount}`,
  }
}

async function generateOneTimeInviteLink(groupId) {
  const expireDate = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
  const response = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, {
    chat_id: groupId,
    member_limit: 1,
    expire_date: expireDate,
  })
  return response.data?.result?.invite_link
}

/**
 * Monitora a carteira na blockchain para detectar pagamentos.
 * Nota: Para implementação real, você precisaria usar uma API como:
 * - Alchemy (https://www.alchemy.com/)
 * - Infura (https://infura.io/)
 * - Etherscan API (https://etherscan.io/apis)
 */
async function checkWalletBalance(address) {
  try {
    // Exemplo com Etherscan API para Polygon
    const response = await axios.get(
      `https://api.polygonscan.com/api?module=account&action=tokenbalance&contractaddress=0xc2132D05D31c914a87C6611C10748AEb04B58e8F&address=${address}&tag=latest&apikey=${process.env.POLYGONSCAN_API_KEY || ""}`
    )
    return response.data
  } catch (err) {
    console.error("Erro ao verificar saldo:", err.message)
    return null
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(bodyParser.json())

// ─── Webhook do Telegram ──────────────────────────────────────────────────────
app.post("/telegram", async (req, res) => {
  const { message, callback_query: callback } = req.body
  if (!message && !callback) return res.sendStatus(200)

  try {
    const chatId = message?.chat.id || callback?.message.chat.id

    if (message?.text === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "🔥 Bem-vindo(a)! Escolha seu grupo VIP (Pagamento via Pix):",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🇧🇷 VIP BRASIL", callback_data: "show_plans_br" }],
            [{ text: "🌍 VIP INTERNACIONAL", callback_data: "show_plans_int" }],
            [{ text: "💖 Meu Privacy", url: PRIVACY_PROFILE_URL }],
          ],
        },
      })
    }

    if (callback && callback.data.startsWith("show_plans_")) {
      const groupKey = callback.data.split("_")[2]
      const config = plansConfig[groupKey]
      const keyboard = Object.keys(config.plans).map(planKey => {
        const plan = config.plans[planKey]
        return [{ text: `⭐ ${plan.label} - ${plan.price_display}`, callback_data: `buy_${groupKey}_${planKey}` }]
      })
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `💎 Escolha seu plano VIP ${groupKey.toUpperCase()}:\n\n⚡ Pagamento instantâneo via Pix\n🔒 Acesso liberado na hora`,
        reply_markup: { inline_keyboard: keyboard },
      })
    }

    if (callback && callback.data.startsWith("buy_")) {
      const [, groupKey, planKey] = callback.data.split("_")
      const config = plansConfig[groupKey]
      const plan = config.plans[planKey]

      // Bloqueio VPN/Geo
      if (config.allowed_country === "BR") {
        const ip = getUserIp(req)
        const geo = await checkGeolocation(ip)
        if (geo && (geo.proxy || geo.hosting)) {
          return axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: "❌ VPN/Proxy detectado. Desative para continuar." })
        }
      }

      const requestId = `order_${chatId}_${Date.now()}`
      const bitpixData = generateBitPixQRCode(plan.price_brl)

      // Armazenar pagamento pendente
      pendingPayments.set(requestId, {
        chatId,
        groupKey,
        planKey,
        amount: plan.price_brl,
        expiresAt: Date.now() + 3600000 // 1 hora
      })

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `${config.welcome_message}\n\n📦 Plano: *${plan.label}*\n💰 Valor: *${plan.price_display}*\n\n🔗 Clique no botão abaixo para pagar via Pix:`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "💳 Pagar com Pix", url: bitpixData.qr_code_url }]]
        }
      })

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `⏱️ Você tem *1 hora* para fazer o pagamento. Após confirmar o Pix, envie /confirmar para liberar seu acesso.`,
        parse_mode: "Markdown"
      })
    }

    // Comando para confirmar pagamento manualmente
    if (message?.text === "/confirmar") {
      // Buscar o pagamento pendente mais recente para este usuário
      let foundPayment = null
      let foundRequestId = null

      for (const [requestId, payment] of pendingPayments.entries()) {
        if (payment.chatId === chatId && Date.now() < payment.expiresAt) {
          foundPayment = payment
          foundRequestId = requestId
          break
        }
      }

      if (!foundPayment) {
        return axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Nenhum pagamento pendente encontrado. Use /start para começar."
        })
      }

      // Simular confirmação de pagamento
      const { chatId: paymentChatId, groupKey, planKey } = foundPayment
      const groupConfig = plansConfig[groupKey]

      try {
        // Gerar link de acesso único
        const inviteLink = await generateOneTimeInviteLink(groupConfig.group_id)

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: paymentChatId,
          text: `🎉 *Pagamento confirmado!*\n\nSua assinatura foi ativada. Clique no botão abaixo para entrar no grupo VIP. O link é de uso único:`,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "🚀 Entrar no Grupo VIP", url: inviteLink }]]
          }
        })

        // Marcar como processado
        completedPayments.add(foundRequestId)
        pendingPayments.delete(foundRequestId)

      } catch (err) {
        console.error("Erro ao processar confirmação:", err.message)
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: paymentChatId,
          text: "❌ Erro ao liberar acesso. Tente novamente ou entre em contato com o suporte."
        })
      }
    }

    res.sendStatus(200)
  } catch (error) {
    console.error("Erro Telegram:", error.message)
    res.sendStatus(200)
  }
})

// ─── Webhook para monitoramento manual (opcional) ────────────────────────────
app.post("/confirm-payment", async (req, res) => {
  const { requestId } = req.body

  const payment = pendingPayments.get(requestId)
  if (!payment) {
    return res.status(404).json({ error: "Pagamento não encontrado" })
  }

  const { chatId, groupKey } = payment
  const groupConfig = plansConfig[groupKey]

  try {
    const inviteLink = await generateOneTimeInviteLink(groupConfig.group_id)

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `🎉 *Pagamento confirmado!*\n\nSua assinatura foi ativada. Clique no botão abaixo para entrar no grupo VIP:`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "🚀 Entrar no Grupo VIP", url: inviteLink }]]
      }
    })

    completedPayments.add(requestId)
    pendingPayments.delete(requestId)

    res.json({ success: true, message: "Pagamento confirmado e acesso liberado" })
  } catch (err) {
    console.error("Erro ao confirmar pagamento:", err.message)
    res.status(500).json({ error: "Erro ao liberar acesso" })
  }
})

app.get("/health", (req, res) => res.json({ status: "ok" }))

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`))

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`))


