const express = require("express")
const bodyParser = require("body-parser")
const axios = require("axios")
const crypto = require("crypto")

const app = express()
const PORT = process.env.PORT || 8080

const BOT_TOKEN = process.env.BOT_TOKEN
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

// ENV
const HUBLA_LINK_BR_MONTHLY = process.env.HUBLA_LINK_BR_MONTHLY?.trim() || ""
const HUBLA_LINK_BR_QUARTERLY = process.env.HUBLA_LINK_BR_QUARTERLY?.trim() || ""
const HUBLA_LINK_BR_SEMIANNUAL = process.env.HUBLA_LINK_BR_SEMIANNUAL?.trim() || ""

const HUBLA_LINK_INT_MONTHLY = process.env.HUBLA_LINK_INT_MONTHLY?.trim() || ""
const HUBLA_LINK_INT_QUARTERLY = process.env.HUBLA_LINK_INT_QUARTERLY?.trim() || ""
const HUBLA_LINK_INT_SEMIANNUAL = process.env.HUBLA_LINK_INT_SEMIANNUAL?.trim() || ""

const PRIVACY_PROFILE_URL = process.env.PRIVACY_PROFILE_URL?.trim() || ""

const IP_API_KEY = process.env.IP_API_KEY || ""

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))

// armazenar tokens
const activeLinks = new Map()

function generateToken() {
  return crypto.randomBytes(16).toString("hex")
}

// pegar IP real (corrigido para Railway)
function getUserIp(req) {

  const forwarded = req.headers["x-forwarded-for"]

  if (forwarded) {
    return forwarded.split(",")[0].trim()
  }

  return req.socket.remoteAddress
}

// geolocalização
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

// configuração planos
const plansConfig = {

  br: {
    welcome_message: "✅ Clique no link para finalizar a assinatura no Hubla e entrar no VIP BRASIL:",
    allowed_country: "BR",

    plans: {

      monthly: {
        link: HUBLA_LINK_BR_MONTHLY,
        label: "Mensal",
        price_display: "R$ 29,90"
      },

      quarterly: {
        link: HUBLA_LINK_BR_QUARTERLY,
        label: "Trimestral",
        price_display: "R$ 76,24"
      },

      semiannual: {
        link: HUBLA_LINK_BR_SEMIANNUAL,
        label: "Semestral",
        price_display: "R$ 134,55"
      }

    }
  },

  int: {
    welcome_message: "✅ Click the link to complete your Hubla subscription and join VIP INTERNATIONAL:",
    allowed_country: null,

    plans: {

      monthly: {
        link: HUBLA_LINK_INT_MONTHLY,
        label: "Monthly",
        price_display: "€ 7,99"
      },

      quarterly: {
        link: HUBLA_LINK_INT_QUARTERLY,
        label: "Quarterly",
        price_display: "€ 20,99"
      },

      semiannual: {
        link: HUBLA_LINK_INT_SEMIANNUAL,
        label: "Semiannual",
        price_display: "€ 36,99"
      }

    }
  }

}

// webhook telegram
app.post("/telegram", async (req, res) => {

  const { message, callback_query: callback } = req.body

  try {

    // START
    if (message && message.text === "/start") {

      await axios.post(`${TELEGRAM_API}/sendMessage`, {

        chat_id: message.chat.id,

        text: "🔥 Bem-vindo(a)! Escolha seu grupo VIP:",

        reply_markup: {

          inline_keyboard: [

            [{ text: "🇧🇷 VIP BRASIL", callback_data: "show_plans_br" }],

            [{ text: "🌍 VIP INTERNACIONAL", callback_data: "show_plans_int" }],

            [{ text: "💖 Meu Privacy", url: PRIVACY_PROFILE_URL }]

          ]

        }

      })

    }

    // mostrar planos
    if (callback && (callback.data === "show_plans_br" || callback.data === "show_plans_int")) {

      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: callback.id
      })

      const groupKey = callback.data.split("_")[2]
      const config = plansConfig[groupKey]

      const keyboard = Object.keys(config.plans).map(planKey => {

        const plan = config.plans[planKey]

        return [{
          text: `⭐ ${plan.label} - ${plan.price_display}`,
          callback_data: `buy_${groupKey}_${planKey}`
        }]

      })

      await axios.post(`${TELEGRAM_API}/sendMessage`, {

        chat_id: callback.message.chat.id,

        text: `💎 Escolha seu plano VIP ${groupKey.toUpperCase()}:`,

        reply_markup: { inline_keyboard: keyboard }

      })

    }

    // compra
    const buyRegex = /^buy_(br|int)_(monthly|quarterly|semiannual)$/

    if (callback && buyRegex.test(callback.data)) {

      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: callback.id
      })

      const chatId = callback.message.chat.id
      const userLang = callback.from.language_code

      const [, groupKey, planKey] = callback.data.match(buyRegex)

      const config = plansConfig[groupKey]
      const plan = config.plans[planKey]

      // bloqueio para BR
      if (config.allowed_country === "BR") {

        const ip = getUserIp(req)
        const geo = await checkGeolocation(ip)

        const isBrazilIP = geo && geo.countryCode === "BR"
        const isPortuguese = userLang === "pt-br" || userLang === "pt"

        if (!isBrazilIP && !isPortuguese) {

          await axios.post(`${TELEGRAM_API}/sendMessage`, {

            chat_id: chatId,

            text: "❌ This group is exclusive to Brazil."

          })

          return res.sendStatus(200)

        }

      }

      // gerar token
      const token = generateToken()

      activeLinks.set(token, {

        user: chatId,

        checkout: plan.link,

        expires: Date.now() + 10 * 60 * 1000

      })

      const secureLink = `${req.protocol}://${req.get("host")}/checkout?token=${token}`

      await axios.post(`${TELEGRAM_API}/sendMessage`, {

        chat_id: chatId,

        text: config.welcome_message + "\n\n⚠️ Este link é pessoal e expira em 10 minutos.",

        reply_markup: {

          inline_keyboard: [

            [{ text: `👉 Assinar ${plan.label}`, url: secureLink }]

          ]

        }

      })

    }

    res.sendStatus(200)

  } catch (error) {

    console.log("Erro Telegram:", error.message)

    res.sendStatus(200)

  }

})

// checkout seguro
app.get("/checkout", (req, res) => {

  const { token } = req.query

  if (!token || !activeLinks.has(token)) {

    return res.send("❌ Link inválido ou expirado.")

  }

  const data = activeLinks.get(token)

  if (Date.now() > data.expires) {

    activeLinks.delete(token)

    return res.send("⏰ Link expirado.")

  }

  activeLinks.delete(token)

  res.redirect(data.checkout)

})

app.listen(PORT, () => {

  console.log("Server running on port " + PORT)

})


