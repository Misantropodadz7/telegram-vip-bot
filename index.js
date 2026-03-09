const express = require("express")
const bodyParser = require("body-parser")
const axios = require("axios")
const crypto = require("crypto")

const app = express()
const PORT = process.env.PORT || 8080

// ─── Telegram ────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

// ─── Cryptomus ───────────────────────────────────────────────────────────────
// Obtenha em: https://app.cryptomus.com → Merchant → API Keys
const CRYPTOMUS_MERCHANT_ID = process.env.CRYPTOMUS_MERCHANT_ID?.trim() || ""
const CRYPTOMUS_PAYMENT_KEY = process.env.CRYPTOMUS_PAYMENT_KEY?.trim() || ""

// ─── IDs dos grupos VIP (obtenha adicionando o bot como admin e usando /start) ─
const VIP_BR_GROUP_ID   = process.env.VIP_BR_GROUP_ID?.trim()  || ""   // ex: -1001234567890
const VIP_INT_GROUP_ID  = process.env.VIP_INT_GROUP_ID?.trim() || ""   // ex: -1009876543210

// ─── Outros ENVs ─────────────────────────────────────────────────────────────
const PRIVACY_PROFILE_URL = process.env.PRIVACY_PROFILE_URL?.trim() || ""
const IP_API_KEY          = process.env.IP_API_KEY || ""

// ─── Configuração de planos ───────────────────────────────────────────────────
// Preços em USD (Cryptomus converte automaticamente para a cripto escolhida)
const plansConfig = {
  br: {
    welcome_message: "✅ Escolha a moeda cripto e finalize o pagamento para entrar no VIP BRASIL:",
    allowed_country: "BR",
    group_id: VIP_BR_GROUP_ID,
    plans: {
      monthly:    { label: "Mensal",     price_usd: "5.50",  price_display: "R$ 29,90" },
      quarterly:  { label: "Trimestral", price_usd: "14.00", price_display: "R$ 76,24" },
      semiannual: { label: "Semestral",  price_usd: "24.50", price_display: "R$ 134,55" },
    },
  },
  int: {
    welcome_message: "✅ Choose your crypto and complete the payment to join VIP INTERNATIONAL:",
    allowed_country: null,
    group_id: VIP_INT_GROUP_ID,
    plans: {
      monthly:    { label: "Monthly",    price_usd: "7.99",  price_display: "€ 7,99" },
      quarterly:  { label: "Quarterly",  price_usd: "20.99", price_display: "€ 20,99" },
      semiannual: { label: "Semiannual", price_usd: "36.99", price_display: "€ 36,99" },
    },
  },
}

// ─── Armazenamento em memória ─────────────────────────────────────────────────
// Mapeia order_id → { chatId, groupId, planLabel, expiresAt }
const pendingPayments = new Map()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getUserIp(req) {
  const forwarded = req.headers["x-forwarded-for"]
  if (forwarded) return forwarded.split(",")[0].trim()
  return req.socket.remoteAddress
}

async function checkGeolocation(ip) {
  try {
    const url =
      `http://ip-api.com/json/${ip}?fields=countryCode,proxy,hosting` +
      (IP_API_KEY ? `&key=${IP_API_KEY}` : "")
    const response = await axios.get(url)
    return response.data
  } catch (err) {
    console.log("Erro IP API:", err.message)
    return null
  }
}

/**
 * Verifica a assinatura do webhook do Cryptomus.
 * Algoritmo: MD5( base64( JSON_sem_sign ) + PAYMENT_KEY )
 */
function verifyCryptomusSignature(body) {
  const receivedSign = body.sign
  if (!receivedSign) return false

  const dataCopy = { ...body }
  delete dataCopy.sign

  // Cryptomus exige JSON com barras escapadas (como PHP json_encode)
  const jsonStr = JSON.stringify(dataCopy).replace(/\//g, "\\/")
  const hash = crypto
    .createHash("md5")
    .update(Buffer.from(jsonStr).toString("base64") + CRYPTOMUS_PAYMENT_KEY)
    .digest("hex")

  return hash === receivedSign
}

/**
 * Cria uma invoice no Cryptomus e retorna a URL de pagamento.
 * Documentação: https://doc.cryptomus.com/merchant-api/payments/creating-invoice
 */
async function createCryptomusInvoice({ orderId, amountUsd, chatId, groupKey, planKey }) {
  const body = {
    amount:       amountUsd,
    currency:     "USD",
    order_id:     orderId,
    url_callback: `${process.env.WEBHOOK_BASE_URL}/cryptomus-webhook`,
    url_success:  `${process.env.WEBHOOK_BASE_URL}/payment-success`,
    url_return:   `${process.env.WEBHOOK_BASE_URL}/payment-cancel`,
    lifetime:     3600,                  // 1 hora para pagar
    additional_data: JSON.stringify({ chatId, groupKey, planKey }),
  }

  const jsonBody = JSON.stringify(body)
  const sign = crypto
    .createHash("md5")
    .update(Buffer.from(jsonBody).toString("base64") + CRYPTOMUS_PAYMENT_KEY)
    .digest("hex")

  const response = await axios.post(
    "https://api.cryptomus.com/v1/payment",
    body,
    {
      headers: {
        merchant:     CRYPTOMUS_MERCHANT_ID,
        sign:         sign,
        "Content-Type": "application/json",
      },
    }
  )

  return response.data?.result
}

/**
 * Gera um invite link de uso único (member_limit: 1) para o grupo VIP.
 * O bot precisa ser admin do grupo com permissão "Invite Users".
 */
async function generateOneTimeInviteLink(groupId) {
  const expireDate = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 // 7 dias

  const response = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, {
    chat_id:      groupId,
    member_limit: 1,
    expire_date:  expireDate,
  })

  return response.data?.result?.invite_link
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))

// ─── Webhook do Telegram ──────────────────────────────────────────────────────
app.post("/telegram", async (req, res) => {
  const { message, callback_query: callback } = req.body

  try {
    // /start
    if (message?.text === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: message.chat.id,
        text: "🔥 Bem-vindo(a)! Escolha seu grupo VIP:",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🇧🇷 VIP BRASIL",        callback_data: "show_plans_br"  }],
            [{ text: "🌍 VIP INTERNACIONAL",   callback_data: "show_plans_int" }],
            [{ text: "💖 Meu Privacy",          url: PRIVACY_PROFILE_URL       }],
          ],
        },
      })
    }

    // Mostrar planos
    if (callback && (callback.data === "show_plans_br" || callback.data === "show_plans_int")) {
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callback.id })

      const groupKey = callback.data.split("_")[2]
      const config   = plansConfig[groupKey]

      const keyboard = Object.keys(config.plans).map(planKey => {
        const plan = config.plans[planKey]
        return [{ text: `⭐ ${plan.label} - ${plan.price_display}`, callback_data: `buy_${groupKey}_${planKey}` }]
      })

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: callback.message.chat.id,
        text: `💎 Escolha seu plano VIP ${groupKey.toUpperCase()}:\n\n💳 Pagamento 100% em cripto (BTC, USDT, ETH e +200 moedas)\n🔒 Privado, seguro e sem intermediários`,
        reply_markup: { inline_keyboard: keyboard },
      })
    }

    // Compra
    const buyRegex = /^buy_(br|int)_(monthly|quarterly|semiannual)$/
    if (callback && buyRegex.test(callback.data)) {
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callback.id })

      const chatId   = callback.message.chat.id
      const userId   = callback.from.id
      const userLang = callback.from.language_code
      const [, groupKey, planKey] = callback.data.match(buyRegex)
      const config = plansConfig[groupKey]
      const plan   = config.plans[planKey]

      // ── Bloqueio geográfico + VPN para plano BR ──────────────────────────
      if (config.allowed_country === "BR") {
        const ip  = getUserIp(req)
        const geo = await checkGeolocation(ip)

        // Bloqueia VPN/proxy/hosting
        if (geo && (geo.proxy === true || geo.hosting === true)) {
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: "❌ Detectamos o uso de VPN ou proxy. Desative-o para acessar o VIP Brasil.",
          })
          return res.sendStatus(200)
        }

        const isBrazilIP   = geo && geo.countryCode === "BR"
        const isPortuguese = userLang === "pt-br" || userLang === "pt"

        if (!isBrazilIP && !isPortuguese) {
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: "❌ Este grupo é exclusivo para o Brasil.",
          })
          return res.sendStatus(200)
        }
      }

      // ── Criar invoice no Cryptomus ────────────────────────────────────────
      // order_id único: userId + timestamp
      const orderId = `vip-${userId}-${Date.now()}`

      let invoice
      try {
        invoice = await createCryptomusInvoice({
          orderId,
          amountUsd: plan.price_usd,
          chatId,
          groupKey,
          planKey,
        })
      } catch (err) {
        console.error("Erro ao criar invoice Cryptomus:", err?.response?.data || err.message)
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "⚠️ Erro ao gerar o link de pagamento. Tente novamente em instantes.",
        })
        return res.sendStatus(200)
      }

      // Salva pendência em memória (fallback caso o webhook chegue antes do redirect)
      pendingPayments.set(orderId, {
        chatId,
        groupId:   config.group_id,
        planLabel: plan.label,
        expiresAt: Date.now() + 60 * 60 * 1000, // 1 hora
      })

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text:
          `${config.welcome_message}\n\n` +
          `📦 Plano: *${plan.label}* — ${plan.price_display}\n` +
          `💰 Valor em USD: $${plan.price_usd}\n\n` +
          `⚠️ Este link expira em *1 hora*. Após o pagamento confirmado, você receberá o link de acesso automaticamente.`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: `💳 Pagar ${plan.price_display}`, url: invoice.url }],
          ],
        },
      })
    }

    res.sendStatus(200)
  } catch (error) {
    console.error("Erro Telegram webhook:", error.message)
    res.sendStatus(200)
  }
})

// ─── Webhook do Cryptomus (IPN) ───────────────────────────────────────────────
app.post("/cryptomus-webhook", async (req, res) => {
  try {
    const body = req.body

    // 1. Verificar assinatura
    if (!verifyCryptomusSignature(body)) {
      console.warn("Webhook Cryptomus: assinatura inválida!", JSON.stringify(body))
      return res.sendStatus(400)
    }

    const { order_id, status, is_final, additional_data } = body

    console.log(`Cryptomus webhook | order_id=${order_id} status=${status} is_final=${is_final}`)

    // 2. Só processar pagamentos finalizados como "paid" ou "paid_over"
    if (!is_final || (status !== "paid" && status !== "paid_over")) {
      return res.sendStatus(200)
    }

    // 3. Recuperar dados do pedido
    let chatId, groupId, planLabel

    // Tenta primeiro o mapa em memória
    if (pendingPayments.has(order_id)) {
      const data = pendingPayments.get(order_id)
      chatId    = data.chatId
      groupId   = data.groupId
      planLabel = data.planLabel
      pendingPayments.delete(order_id)
    } else if (additional_data) {
      // Fallback: dados salvos no campo additional_data da invoice
      try {
        const parsed = JSON.parse(additional_data)
        chatId    = parsed.chatId
        groupId   = plansConfig[parsed.groupKey]?.group_id
        planLabel = plansConfig[parsed.groupKey]?.plans[parsed.planKey]?.label
      } catch (e) {
        console.error("Erro ao parsear additional_data:", e.message)
      }
    }

    if (!chatId || !groupId) {
      console.error(`Dados insuficientes para liberar acesso | order_id=${order_id}`)
      return res.sendStatus(200)
    }

    // 4. Gerar invite link de uso único
    let inviteLink
    try {
      inviteLink = await generateOneTimeInviteLink(groupId)
    } catch (err) {
      console.error("Erro ao gerar invite link:", err?.response?.data || err.message)
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "✅ Pagamento confirmado! Mas houve um erro ao gerar seu link de acesso. Entre em contato com o suporte.",
      })
      return res.sendStatus(200)
    }

    // 5. Enviar link de acesso ao usuário
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text:
        `🎉 *Pagamento confirmado!* Bem-vindo(a) ao VIP!\n\n` +
        `📦 Plano: *${planLabel}*\n\n` +
        `👇 Clique no botão abaixo para entrar no grupo. O link é de *uso único* e expira em 7 dias:`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚀 Entrar no Grupo VIP", url: inviteLink }],
        ],
      },
    })

    res.sendStatus(200)
  } catch (error) {
    console.error("Erro no webhook Cryptomus:", error.message)
    res.sendStatus(200)
  }
})

// ─── Páginas de retorno ───────────────────────────────────────────────────────
app.get("/payment-success", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Pagamento Recebido</title>
      <style>
        body { font-family: sans-serif; display: flex; justify-content: center;
               align-items: center; height: 100vh; margin: 0; background: #0f0f0f; color: #fff; }
        .box { text-align: center; padding: 2rem; }
        h1 { color: #4caf50; font-size: 2rem; }
        p  { color: #ccc; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>✅ Pagamento Recebido!</h1>
        <p>Aguarde a confirmação na blockchain. Você receberá o link de acesso diretamente no Telegram em instantes.</p>
        <p>Pode fechar esta janela.</p>
      </div>
    </body>
    </html>
  `)
})

app.get("/payment-cancel", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Pagamento Cancelado</title>
      <style>
        body { font-family: sans-serif; display: flex; justify-content: center;
               align-items: center; height: 100vh; margin: 0; background: #0f0f0f; color: #fff; }
        .box { text-align: center; padding: 2rem; }
        h1 { color: #f44336; font-size: 2rem; }
        p  { color: #ccc; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>❌ Pagamento não concluído</h1>
        <p>Você pode tentar novamente a qualquer momento pelo bot no Telegram.</p>
        <p>Pode fechar esta janela.</p>
      </div>
    </body>
    </html>
  `)
})

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }))

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`)
  console.log(`   Cryptomus Merchant: ${CRYPTOMUS_MERCHANT_ID || "(não configurado)"}`)
  console.log(`   VIP BR  Group ID:   ${VIP_BR_GROUP_ID  || "(não configurado)"}`)
  console.log(`   VIP INT Group ID:   ${VIP_INT_GROUP_ID || "(não configurado)"}`)
})


