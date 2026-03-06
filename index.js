const express = require("express")
const bodyParser = require("body-parser")
const axios = require("axios")
const Stripe = require("stripe")
const https = require("https" ); // Necessário para configurar o agente HTTPS

const app = express()
const PORT = process.env.PORT || 8080
const BOT_TOKEN = process.env.BOT_TOKEN
const GROUP_ID = process.env.GROUP_ID

// ✅ Limpa espaços/caracteres invisíveis das chaves
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.trim() : '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ? process.env.STRIPE_WEBHOOK_SECRET.trim() : '';

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

// ✅ Configuração da biblioteca Stripe para Webhooks (não afeta a criação de sessão )
const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

// ✅ Configuração do Axios para chamadas diretas ao Stripe (mais resiliente)
const stripeAxios = axios.create({
  baseURL: "https://api.stripe.com/v1",
  headers: {
    "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded"
  },
  timeout: 40000, // Timeout de 40 segundos
  httpsAgent: new https.Agent({ rejectUnauthorized: false } ) // Ignora erros de certificado (para ambientes restritos)
});

// ✅ Verificação inicial das variáveis de ambiente
if (!BOT_TOKEN || !STRIPE_SECRET_KEY || !GROUP_ID || !STRIPE_WEBHOOK_SECRET) {
  console.error("❌ ERRO: Variáveis essenciais (BOT_TOKEN, STRIPE_SECRET_KEY, GROUP_ID, STRIPE_WEBHOOK_SECRET) não foram definidas no Railway.");
  process.exit(1);
}

// ⚠️ Webhook precisa do body RAW
app.use("/stripe-webhook", bodyParser.raw({ type: "application/json" }))
app.use(bodyParser.json())

// ─────────────────────────────────────────
// ENDPOINT DO TELEGRAM
// ─────────────────────────────────────────
app.post("/telegram", async (req, res) => {
  const { message, callback_query: callback } = req.body

  try {
    // COMANDO /start
    if (message && message.text === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: message.chat.id,
        text: "🔥 Bem-vindo ao VIP 🔥\n\nClique abaixo para acessar o conteúdo exclusivo.",
        reply_markup: {
          inline_keyboard: [[{ text: "💎 Ver opções de assinatura", callback_data: "show_plans" }]]
        }
      })
    }

    // BOTÃO: VER OPÇÕES
    if (callback && callback.data === "show_plans") {
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callback.id })
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: callback.message.chat.id,
        text: "💎 Escolha seu plano VIP:",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⭐ Mensal - € 7,99", callback_data: "buy_monthly" }],
            [{ text: "🗓️ Trimestral - € 20,99", callback_data: "buy_quarterly" }],
            [{ text: "☀️ Semestral - € 36,99", callback_data: "buy_semiannual" }]
          ]
        }
      })
    }

    // LÓGICA DE COMPRA (MENSAL, TRIMESTRAL, SEMESTRAL)
    const planMap = {
      "buy_monthly": { id: process.env.STRIPE_PRICE_MONTHLY, label: "Mensal" },
      "buy_quarterly": { id: process.env.STRIPE_PRICE_QUARTERLY, label: "Trimestral" },
      "buy_semiannual": { id: process.env.STRIPE_PRICE_SEMIANNUAL, label: "Semestral" }
    }

    if (callback && planMap[callback.data]) {
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callback.id })
      const chatId = callback.message.chat.id
      const plan = planMap[callback.data]

      await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: `⏳ Gerando link para plano ${plan.label}...` })

      try {
        console.log(`Tentando criar sessão de checkout para ${plan.label} via Axios...`);
        const response = await stripeAxios.post(
          "/checkout/sessions",
          new URLSearchParams({
            "payment_method_types[0]": "card",
            "line_items[0][price]": plan.id,
            "line_items[0][quantity]": 1,
            "mode": "subscription",
            "metadata[telegram_chat_id]": String(chatId),
            "success_url": "https://t.me/ManuBelluccibot",
            "cancel_url": "https://t.me/ManuBelluccibot"
          } ).toString()
        );
        const session = response.data;

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `💳 Clique abaixo para pagar e entrar no VIP:\n\n${session.url}`
        })
      } catch (err) {
        console.error(`Erro Stripe (${plan.label}) via Axios:`, err.message);
        if (err.response) {
          console.error("Stripe Response Data:", err.response.data);
          console.error("Stripe Response Status:", err.response.status);
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: `❌ Erro ao gerar o link de pagamento (${plan.label}). Detalhes: ${err.response.data.error.message || err.message}`
          });
        } else {
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: `❌ Erro de conexão com o Stripe. O Railway está bloqueando a rede. Tente clicar novamente ou aguarde 1 minuto.\nErro: ${err.message}`
          });
        }
      }
    }

    res.sendStatus(200)
  } catch (error) {
    console.error("Erro Telegram:", error.message)
    res.sendStatus(200)
  }
})

// ─────────────────────────────────────────
// WEBHOOK DO STRIPE (ENTRADA E SAÍDA)
// ─────────────────────────────────────────
app.post("/stripe-webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"]
  let event

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error("Webhook inválido:", err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  // ✅ PAGAMENTO CONFIRMADO -> ENVIAR LINK
  if (event.type === "checkout.session.completed") {
    const session = event.data.object
    const chatId = session.metadata?.telegram_chat_id

    if (chatId) {
      try {
        // Salva o Telegram ID no Customer do Stripe para remoção futura
        // Usando a biblioteca Stripe aqui, pois é uma chamada interna e não de rede externa
        await stripe.customers.update(session.customer, { metadata: { telegram_chat_id: chatId } })

        // Gera link de convite único
        const invite = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, {
          chat_id: GROUP_ID,
          member_limit: 1,
          expire_date: Math.floor(Date.now() / 1000) + 86400
        })

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `✅ Pagamento confirmado! Entre no VIP pelo link único:\n${invite.data.result.invite_link}`
        })
      } catch (e) { console.error("Erro no convite:", e.message) }
    }
  }

  // ❌ ASSINATURA CANCELADA/ATRASADA -> BANIR
  if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") {
    const sub = event.data.object
    if (["canceled", "unpaid", "past_due"].includes(sub.status)) {
      try {
        // Usando a biblioteca Stripe aqui
        const customer = await stripe.customers.retrieve(sub.customer)
        const chatId = customer.metadata?.telegram_chat_id
        if (chatId) {
          await axios.post(`${TELEGRAM_API}/banChatMember`, { chat_id: GROUP_ID, user_id: chatId })
          await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: "❌ Sua assinatura VIP expirou e você foi removido do grupo." })
        }
      } catch (e) { console.error("Erro no banimento:", e.message) }
    }
  }

  res.sendStatus(200)
})

app.listen(PORT, () => console.log("Server running on port " + PORT))
