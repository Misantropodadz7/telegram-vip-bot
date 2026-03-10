const express    = require("express")
const bodyParser = require("body-parser")
const axios      = require("axios")
const FormData   = require("form-data")

const app  = express()
const PORT = process.env.PORT || 3000

// ─── Telegram ────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

// ─── PushinPay ────────────────────────────────────────────────────────────────
// Aceita cadastro de pessoa física (CPF). Cadastre-se em:
// https://app.pushinpay.com.br/register
// Taxa: R$ 0,35 por transação Pix.
const PUSHINPAY_TOKEN = process.env.PUSHINPAY_TOKEN?.trim() || ""
const PUSHINPAY_API   = "https://api.pushinpay.com.br/api"

// ─── URL base do servidor Railway ────────────────────────────────────────────
// Exemplo: https://meu-bot.up.railway.app
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL?.trim() || ""

// ─── IDs dos grupos VIP ───────────────────────────────────────────────────────
const VIP_BR_GROUP_ID  = process.env.VIP_BR_GROUP_ID?.trim()  || ""
const VIP_INT_GROUP_ID = process.env.VIP_INT_GROUP_ID?.trim() || ""

// ─── Outros ENVs ──────────────────────────────────────────────────────────────
const PRIVACY_PROFILE_URL = process.env.PRIVACY_PROFILE_URL?.trim() || ""
const IP_API_KEY          = process.env.IP_API_KEY || ""

// ─── Configuração de planos ───────────────────────────────────────────────────
const plansConfig = {
  br: {
    welcome_message: "Pague o Pix abaixo para entrar no VIP BRASIL automaticamente:",
    allowed_country: "BR",
    group_id: VIP_BR_GROUP_ID,
    plans: {
      monthly:    { label: "Mensal",     price_brl: 2990,  price_display: "R$ 29,90"  },
      quarterly:  { label: "Trimestral", price_brl: 7624,  price_display: "R$ 76,24"  },
      semiannual: { label: "Semestral",  price_brl: 13455, price_display: "R$ 134,55" },
    },
  },
  int: {
    welcome_message: "Pay the Pix below to join VIP INTERNATIONAL automatically:",
    allowed_country: null,
    group_id: VIP_INT_GROUP_ID,
    plans: {
      monthly:    { label: "Monthly",    price_brl: 4500,  price_display: "R$ 45,00"  },
      quarterly:  { label: "Quarterly",  price_brl: 11500, price_display: "R$ 115,00" },
      semiannual: { label: "Semiannual", price_brl: 20000, price_display: "R$ 200,00" },
    },
  },
}

// ─── Armazenamento em memória ─────────────────────────────────────────────────
// Chave: pixId (ID da transação PushinPay)
// Valor: { chatId, groupKey, planKey, expiresAt, amount }
const pendingPayments  = new Map()
const completedPayments = new Set()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getUserIp(req) {
  const forwarded = req.headers["x-forwarded-for"]
  if (forwarded) return forwarded.split(",")[0].trim()
  return req.socket.remoteAddress
}

async function checkGeolocation(ip) {
  try {
    const url = `http://ip-api.com/json/${ip}?fields=countryCode,proxy,hosting` +
                (IP_API_KEY ? `&key=${IP_API_KEY}` : "")
    const { data } = await axios.get(url)
    return data
  } catch (err) {
    console.error("Erro geolocalização:", err.message)
    return null
  }
}

/**
 * Cria uma cobrança Pix via PushinPay.
 * Retorna { pixId, qrCode, qrCodeBase64, status }.
 */
async function createPixCharge(amountInCentavos, webhookUrl) {
  const { data } = await axios.post(
    `${PUSHINPAY_API}/pix/cashIn`,
    { value: amountInCentavos, webhook_url: webhookUrl },
    {
      headers: {
        Authorization:  `Bearer ${PUSHINPAY_TOKEN}`,
        Accept:         "application/json",
        "Content-Type": "application/json",
      },
    }
  )
  return {
    pixId:        data.id,
    qrCode:       data.qr_code,         // Código copia-e-cola
    qrCodeBase64: data.qr_code_base64,  // Imagem PNG em base64
    status:       data.status,
  }
}

/**
 * Consulta o status de uma transação Pix na PushinPay.
 * Retorna: "created" | "paid" | "canceled" | null
 */
async function checkPixStatus(pixId) {
  try {
    const { data } = await axios.get(
      `${PUSHINPAY_API}/transactions/${pixId}`,
      {
        headers: {
          Authorization: `Bearer ${PUSHINPAY_TOKEN}`,
          Accept:        "application/json",
        },
      }
    )
    return data.status
  } catch (err) {
    console.error("Erro ao consultar status Pix:", err.message)
    return null
  }
}

/**
 * Envia o QR Code como imagem para o Telegram.
 * O base64 vem da PushinPay no formato "data:image/png;base64,..."
 */
async function sendQrCodeImage(chatId, qrCodeBase64, caption) {
  const base64Data    = qrCodeBase64.replace(/^data:image\/\w+;base64,/, "")
  const imageBuffer   = Buffer.from(base64Data, "base64")
  const form          = new FormData()

  form.append("chat_id",    String(chatId))
  form.append("caption",    caption)
  form.append("parse_mode", "Markdown")
  form.append("photo",      imageBuffer, { filename: "qrcode.png", contentType: "image/png" })

  await axios.post(`${TELEGRAM_API}/sendPhoto`, form, {
    headers: form.getHeaders(),
  })
}

/**
 * Gera link de convite único para o grupo VIP e envia ao usuário.
 */
async function generateOneTimeInviteLink(groupId) {
  const expireDate = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
  const { data }   = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, {
    chat_id:      groupId,
    member_limit: 1,
    expire_date:  expireDate,
  })
  return data?.result?.invite_link
}

/**
 * Libera o acesso ao grupo VIP enviando o link de convite único.
 */
async function liberarAcesso(chatId, groupKey) {
  const groupConfig = plansConfig[groupKey]
  const inviteLink  = await generateOneTimeInviteLink(groupConfig.group_id)

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id:    chatId,
    text:
      `✅ *Pagamento confirmado!*\n\n` +
      `Sua assinatura foi ativada. Clique no botão abaixo para entrar no grupo VIP.\n` +
      `O link é de uso único e expira em 7 dias.`,
    parse_mode:   "Markdown",
    reply_markup: {
      inline_keyboard: [[{ text: "🚀 Entrar no Grupo VIP", url: inviteLink }]],
    },
  })
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(bodyParser.json())

// ─── Webhook do Telegram ──────────────────────────────────────────────────────
app.post("/telegram", async (req, res) => {
  const { message, callback_query: callback } = req.body
  if (!message && !callback) return res.sendStatus(200)

  try {
    const chatId = message?.chat.id || callback?.message.chat.id

    // ── /start ────────────────────────────────────────────────────────────────
    if (message?.text === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text:    "👋 Bem-vindo(a)! Escolha seu grupo VIP (Pagamento via Pix):",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🇧🇷 VIP BRASIL",       callback_data: "show_plans_br"  }],
            [{ text: "🌍 VIP INTERNACIONAL", callback_data: "show_plans_int" }],
            [{ text: "🔒 Meu Privacy",        url: PRIVACY_PROFILE_URL       }],
          ],
        },
      })
    }

    // ── Exibir planos ─────────────────────────────────────────────────────────
    if (callback && callback.data.startsWith("show_plans_")) {
      const groupKey = callback.data.split("_")[2]
      const config   = plansConfig[groupKey]
      const keyboard = Object.keys(config.plans).map((planKey) => {
        const plan = config.plans[planKey]
        return [{ text: `📌 ${plan.label} – ${plan.price_display}`, callback_data: `buy_${groupKey}_${planKey}` }]
      })
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text:    `📋 Escolha seu plano VIP ${groupKey.toUpperCase()}:\n\n⚡ Pagamento instantâneo via Pix\n✅ Acesso liberado automaticamente`,
        reply_markup: { inline_keyboard: keyboard },
      })
    }

    // ── Comprar plano ─────────────────────────────────────────────────────────
    if (callback && callback.data.startsWith("buy_")) {
      const [, groupKey, planKey] = callback.data.split("_")
      const config = plansConfig[groupKey]
      const plan   = config.plans[planKey]

      // Bloqueio VPN/Geo apenas para o grupo Brasil
      if (config.allowed_country === "BR") {
        const ip  = getUserIp(req)
        const geo = await checkGeolocation(ip)
        if (geo && (geo.proxy || geo.hosting)) {
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text:    "⛔ VPN/Proxy detectado. Desative para continuar.",
          })
          return res.sendStatus(200)
        }
      }

      // Avisa que está gerando o Pix
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text:    "⏳ Gerando seu Pix, aguarde...",
      })

      // URL do webhook que a PushinPay chamará ao confirmar o pagamento
      const webhookUrl = `${WEBHOOK_BASE_URL}/pix-webhook`

      let pixData
      try {
        pixData = await createPixCharge(plan.price_brl, webhookUrl)
      } catch (err) {
        console.error("Erro ao criar Pix:", err.response?.data || err.message)
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text:    "❌ Erro ao gerar o Pix. Tente novamente em instantes ou entre em contato com o suporte.",
        })
        return res.sendStatus(200)
      }

      // Armazenar pagamento pendente indexado pelo ID da transação PushinPay
      pendingPayments.set(pixData.pixId, {
        chatId,
        groupKey,
        planKey,
        amount:    plan.price_brl,
        expiresAt: Date.now() + 3600000, // 1 hora
      })

      // Enviar QR Code como imagem
      const caption =
        `${config.welcome_message}\n\n` +
        `📌 Plano: *${plan.label}*\n` +
        `💰 Valor: *${plan.price_display}*\n\n` +
        `⏰ Você tem *1 hora* para pagar.\n` +
        `✅ O acesso é liberado *automaticamente* após a confirmação.`

      try {
        await sendQrCodeImage(chatId, pixData.qrCodeBase64, caption)
      } catch (imgErr) {
        console.error("Erro ao enviar QR Code como imagem:", imgErr.message)
        // Fallback: enviar mensagem de texto com o caption
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id:    chatId,
          text:       caption,
          parse_mode: "Markdown",
        })
      }

      // Enviar código copia-e-cola
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id:    chatId,
        text:
          `📋 *Pix Copia e Cola:*\n\n` +
          `\`${pixData.qrCode}\`\n\n` +
          `_Copie o código acima e cole no seu app bancário._`,
        parse_mode: "Markdown",
      })

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id:    chatId,
        text:
          `✅ Após pagar, o acesso ao grupo VIP será liberado *automaticamente* em segundos.\n\n` +
          `Caso não seja liberado em 5 minutos, use /verificar para checar manualmente.`,
        parse_mode: "Markdown",
      })
    }

    // ── /verificar – verificação manual de status ─────────────────────────────
    if (message?.text === "/verificar") {
      let foundPixId   = null
      let foundPayment = null

      for (const [pixId, payment] of pendingPayments.entries()) {
        if (payment.chatId === chatId && Date.now() < payment.expiresAt) {
          foundPixId   = pixId
          foundPayment = payment
          break
        }
      }

      if (!foundPayment) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text:    "ℹ️ Nenhum pagamento pendente encontrado. Use /start para começar.",
        })
        return res.sendStatus(200)
      }

      // Consultar status diretamente na PushinPay
      const status = await checkPixStatus(foundPixId)

      if (status === "paid") {
        if (!completedPayments.has(foundPixId)) {
          completedPayments.add(foundPixId)
          pendingPayments.delete(foundPixId)
          await liberarAcesso(chatId, foundPayment.groupKey)
        } else {
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text:    "✅ Seu pagamento já foi confirmado e o acesso foi liberado anteriormente.",
          })
        }
      } else if (status === "canceled") {
        pendingPayments.delete(foundPixId)
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text:    "❌ Este Pix foi cancelado ou expirou. Use /start para gerar um novo.",
        })
      } else {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text:    "⏳ Pagamento ainda não confirmado. Aguarde alguns instantes e tente novamente.",
        })
      }
    }

    res.sendStatus(200)
  } catch (error) {
    console.error("Erro Telegram:", error.message)
    res.sendStatus(200)
  }
})

// ─── Webhook da PushinPay (confirmação automática de pagamento) ───────────────
// A PushinPay chama esta rota via POST quando o Pix é confirmado.
// Configure WEBHOOK_BASE_URL como a URL pública do seu servidor Railway.
app.post("/pix-webhook", async (req, res) => {
  try {
    const payload = req.body
    console.log("Webhook PushinPay recebido:", JSON.stringify(payload))

    const pixId  = payload.id
    const status = payload.status

    // Processar apenas confirmações de pagamento
    if (!pixId || status !== "paid") {
      return res.sendStatus(200)
    }

    // Evitar processamento duplicado (idempotência)
    if (completedPayments.has(pixId)) {
      return res.sendStatus(200)
    }

    const payment = pendingPayments.get(pixId)
    if (!payment) {
      console.warn(`Webhook para pixId desconhecido: ${pixId}`)
      return res.sendStatus(200)
    }

    // Verificar se o pagamento não expirou
    if (Date.now() > payment.expiresAt) {
      pendingPayments.delete(pixId)
      console.warn(`Pagamento expirado para pixId: ${pixId}`)
      return res.sendStatus(200)
    }

    // Marcar como processado antes de liberar (evita race condition)
    completedPayments.add(pixId)
    pendingPayments.delete(pixId)

    // Liberar acesso ao grupo VIP automaticamente
    await liberarAcesso(payment.chatId, payment.groupKey)

    console.log(`✅ Acesso liberado: chatId=${payment.chatId}, grupo=${payment.groupKey}`)
    res.sendStatus(200)
  } catch (err) {
    console.error("Erro no webhook PushinPay:", err.message)
    // Sempre responder 200 para evitar retentativas desnecessárias da PushinPay
    res.sendStatus(200)
  }
})

// ─── Rota de saúde ────────────────────────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
)

// ─── Iniciar servidor ─────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))


