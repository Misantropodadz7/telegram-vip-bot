const express = require("express")
const bodyParser = require("body-parser")
const axios = require("axios")
const Stripe = require("stripe")
const https = require("https");

const app = express()
const PORT = process.env.PORT || 8080
const BOT_TOKEN = process.env.BOT_TOKEN

// ✅ Novas variáveis para múltiplos grupos e preços
const GROUP_ID_BR = process.env.GROUP_ID_BR
const GROUP_ID_INT = process.env.GROUP_ID_INT

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.trim() : "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ? process.env.STRIPE_WEBHOOK_SECRET.trim() : "";

// ✅ Variável para a chave da API de Geolocalização (se usar uma versão paga)
const IP_API_KEY = process.env.IP_API_KEY || ''; // O ip-api.com funciona sem chave para uso básico

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

// ✅ Configuração da biblioteca Stripe para Webhooks
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
  timeout: 40000,
  httpsAgent: new https.Agent({ rejectUnauthorized: false })
});

// ✅ Verificação inicial das variáveis de ambiente
if (!BOT_TOKEN || !STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !GROUP_ID_BR || !GROUP_ID_INT) {
  console.error("❌ ERRO: Variáveis essenciais (BOT_TOKEN, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, GROUP_ID_BR, GROUP_ID_INT) não foram definidas no Railway.");
  process.exit(1);
}

// ✅ Mapeamento de planos e grupos
const plansConfig = {
  "br": {
    group_id: GROUP_ID_BR,
    currency_symbol: "R$",
    welcome_message: "✅ Pagamento confirmado! Entre no VIP BRASIL pelo link único:",
    removed_message: "❌ Sua assinatura VIP BRASIL expirou e você foi removido do grupo.",
    plans: {
      "monthly": { id: process.env.STRIPE_PRICE_BR_MONTHLY, label: "Mensal", price_display: "R$ 39,99" },
      "quarterly": { id: process.env.STRIPE_PRICE_BR_QUARTERLY, label: "Trimestral", price_display: "R$ 99,99" },
      "semiannual": { id: process.env.STRIPE_PRICE_BR_SEMIANNUAL, label: "Semestral", price_display: "R$ 189,99" }
    },
    allowed_country: "BR" // ✅ País permitido para este grupo
  },
  "int": {
    group_id: GROUP_ID_INT,
    currency_symbol: "€",
    welcome_message: "✅ Payment confirmed! Join VIP INTERNATIONAL via this unique link:",
    removed_message: "❌ Your VIP INTERNATIONAL subscription has expired and you have been removed from the group.",
    plans: {
      "monthly": { id: process.env.STRIPE_PRICE_INT_MONTHLY, label: "Monthly", price_display: "€ 7,99" },
      "quarterly": { id: process.env.STRIPE_PRICE_INT_QUARTERLY, label: "Quarterly", price_display: "€ 20,99" },
      "semiannual": { id: process.env.STRIPE_PRICE_INT_SEMIANNUAL, label: "Semiannual", price_display: "€ 36,99" }
    },
    allowed_country: null // ✅ Sem restrição de país para este grupo
  }
}

// Função para obter o IP do usuário
function getUserIp(req) {
  return req.headers["x-forwarded-for"] || req.socket.remoteAddress;
}

// Função para verificar a geolocalização
async function checkGeolocation(ip) {
  try {
    const response = await axios.get(`http://ip-api.com/json/${ip}?fields=countryCode,proxy,hosting${IP_API_KEY ? `&key=${IP_API_KEY}` : ''}`);
    return response.data;
  } catch (error) {
    console.error("Erro ao consultar IP-API:", error.message);
    return null;
  }
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
        text: "🔥 Bem-vindo(a)! Escolha seu grupo VIP: 🔥",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🇧🇷 VIP BRASIL", callback_data: "show_plans_br" }],
            [{ text: "🌍 VIP INTERNACIONAL", callback_data: "show_plans_int" }]
          ]
        }
      })
    }

    // BOTÃO: VER OPÇÕES (BRASIL ou INTERNACIONAL)
    if (callback && (callback.data === "show_plans_br" || callback.data === "show_plans_int")) {
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callback.id })
      const groupKey = callback.data.split("_")[2]; // 'br' ou 'int'
      const config = plansConfig[groupKey];

      const inline_keyboard = Object.keys(config.plans).map(planKey => {
        const plan = config.plans[planKey];
        return [{ text: `⭐ ${plan.label} - ${plan.price_display}`, callback_data: `buy_${groupKey}_${planKey}` }];
      });

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: callback.message.chat.id,
        text: `💎 Escolha seu plano VIP ${groupKey.toUpperCase()}:`,
        reply_markup: { inline_keyboard }
      })
    }

    // LÓGICA DE COMPRA (MENSAL, TRIMESTRAL, SEMESTRAL para BR ou INT)
    const buyRegex = /^buy_(br|int)_(monthly|quarterly|semiannual)$/;
    if (callback && buyRegex.test(callback.data)) {
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callback.id })
      const chatId = callback.message.chat.id
      const [, groupKey, planKey] = callback.data.match(buyRegex);
      const config = plansConfig[groupKey];
      const plan = config.plans[planKey];

      // ✅ Lógica de Geolocalização e Bloqueio
      if (config.allowed_country) {
        const userIp = getUserIp(req); // Obtém o IP do usuário
        const geoData = await checkGeolocation(userIp);

        if (!geoData || geoData.countryCode !== config.allowed_country || geoData.proxy || geoData.hosting) {
          let blockMessage = "❌ Acesso negado. Este grupo é exclusivo para o Brasil.";
          if (geoData && (geoData.proxy || geoData.hosting)) {
            blockMessage += " Detectamos o uso de VPN/Proxy. Por favor, desative-o para prosseguir.";
          }
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: blockMessage
          });
          return res.sendStatus(200); // Encerra a requisição
        }
      }

      await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: `⏳ Gerando link para plano ${plan.label} (${groupKey.toUpperCase()})...` })

      try {
        console.log(`Tentando criar sessão de checkout para ${plan.label} (${groupKey.toUpperCase()}) via Axios...`);
        const response = await stripeAxios.post(
          "/checkout/sessions",
          new URLSearchParams({
            "payment_method_types[0]": "card",
            "line_items[0][price]": plan.id,
            "line_items[0][quantity]": 1,
            "mode": "subscription",
            "metadata[telegram_chat_id]": String(chatId),
            "metadata[telegram_group_id]": config.group_id, // ✅ Salva o ID do grupo no metadata
            "success_url": "https://t.me/ManuBelluccibot", // ⚠️ Atualize para o seu bot
            "cancel_url": "https://t.me/ManuBelluccibot" // ⚠️ Atualize para o seu bot
          }).toString()
        );
        const session = response.data;

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `💳 Clique abaixo para pagar e entrar no VIP ${groupKey.toUpperCase()}:\n\n${session.url}`
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
    const targetGroupId = session.metadata?.telegram_group_id; // ✅ Pega o ID do grupo do metadata

    if (chatId && targetGroupId) {
      try {
        // Salva o Telegram ID no Customer do Stripe para remoção futura
        await stripe.customers.update(session.customer, { metadata: { telegram_chat_id: chatId, telegram_group_id: targetGroupId } })

        // Gera link de convite único para o grupo correto
        const invite = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, {
          chat_id: targetGroupId,
          member_limit: 1,
          expire_date: Math.floor(Date.now() / 1000) + 86400
        })

        // Envia mensagem de boas-vindas com base no grupo
        const groupKey = Object.keys(plansConfig).find(key => plansConfig[key].group_id === targetGroupId);
        const welcomeMessage = groupKey ? plansConfig[groupKey].welcome_message : "✅ Pagamento confirmado! Entre no VIP pelo link único:";

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `${welcomeMessage}\n${invite.data.result.invite_link}`
        })
      } catch (e) { console.error("Erro no convite:", e.message) }
    }
  }

  // ❌ ASSINATURA CANCELADA/ATRASADA -> BANIR
  if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") {
    const sub = event.data.object
    if (["canceled", "unpaid", "past_due"].includes(sub.status)) {
      try {
        const customer = await stripe.customers.retrieve(sub.customer)
        const chatId = customer.metadata?.telegram_chat_id
        const targetGroupId = customer.metadata?.telegram_group_id; // ✅ Pega o ID do grupo do metadata

        if (chatId && targetGroupId) {
          await axios.post(`${TELEGRAM_API}/banChatMember`, { chat_id: targetGroupId, user_id: chatId })
          
          // Envia mensagem de remoção com base no grupo
          const groupKey = Object.keys(plansConfig).find(key => plansConfig[key].group_id === targetGroupId);
          const removedMessage = groupKey ? plansConfig[groupKey].removed_message : "❌ Sua assinatura VIP expirou e você foi removido do grupo.";

          await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: removedMessage })
        }
      } catch (e) { console.error("Erro no banimento:", e.message) }
    }
  }

  res.sendStatus(200)
})

app.listen(PORT, () => console.log("Server running on port " + PORT))
