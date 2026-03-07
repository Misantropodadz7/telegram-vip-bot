const express = require("express")
const bodyParser = require("body-parser")
const axios = require("axios")
const https = require("https");

const app = express()
const PORT = process.env.PORT || 8080
const BOT_TOKEN = process.env.BOT_TOKEN

// ✅ Variáveis para múltiplos grupos e links do Hubla
const GROUP_ID_BR = process.env.GROUP_ID_BR // Mantido para referência, mas Hubla gerencia o acesso
const GROUP_ID_INT = process.env.GROUP_ID_INT // Mantido para referência, mas Hubla gerencia o acesso

// ✅ Links de Checkout do Hubla para cada plano
const HUBLA_LINK_BR_MONTHLY = process.env.HUBLA_LINK_BR_MONTHLY ? process.env.HUBLA_LINK_BR_MONTHLY.trim() : "";
const HUBLA_LINK_BR_QUARTERLY = process.env.HUBLA_LINK_BR_QUARTERLY ? process.env.HUBLA_LINK_BR_QUARTERLY.trim() : "";
const HUBLA_LINK_BR_SEMIANNUAL = process.env.HUBLA_LINK_BR_SEMIANNUAL ? process.env.HUBLA_LINK_BR_SEMIANNUAL.trim() : "";

const HUBLA_LINK_INT_MONTHLY = process.env.HUBLA_LINK_INT_MONTHLY ? process.env.HUBLA_LINK_INT_MONTHLY.trim() : "";
const HUBLA_LINK_INT_QUARTERLY = process.env.HUBLA_LINK_INT_QUARTERLY ? process.env.HUBLA_LINK_INT_QUARTERLY.trim() : "";
const HUBLA_LINK_INT_SEMIANNUAL = process.env.HUBLA_LINK_INT_SEMIANNUAL ? process.env.HUBLA_LINK_INT_SEMIANNUAL.trim() : "";

// ✅ URL do perfil Privacy
const PRIVACY_PROFILE_URL = process.env.PRIVACY_PROFILE_URL ? process.env.PRIVACY_PROFILE_URL.trim() : "";

// ✅ Variável para a chave da API de Geolocalização (se usar uma versão paga)
const IP_API_KEY = process.env.IP_API_KEY || "; // O ip-api.com funciona sem chave para uso básico"

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

// ✅ Verificação inicial das variáveis de ambiente
if (!BOT_TOKEN || !GROUP_ID_BR || !GROUP_ID_INT || !PRIVACY_PROFILE_URL ||
    !HUBLA_LINK_BR_MONTHLY || !HUBLA_LINK_BR_QUARTERLY || !HUBLA_LINK_BR_SEMIANNUAL ||
    !HUBLA_LINK_INT_MONTHLY || !HUBLA_LINK_INT_QUARTERLY || !HUBLA_LINK_INT_SEMIANNUAL) {
  console.error("❌ ERRO: Variáveis essenciais (BOT_TOKEN, GROUP_ID_BR, GROUP_ID_INT, PRIVACY_PROFILE_URL, e todos os links do Hubla) não foram definidas no Railway.");
  process.exit(1);
}

// ✅ Mapeamento de planos e grupos (agora com links do Hubla)
const plansConfig = {
  "br": {
    group_id: GROUP_ID_BR, // Mantido para referência e para a lógica de geolocalização
    welcome_message: "✅ Clique no link para finalizar a assinatura no Hubla e entrar no VIP BRASIL:",
    plans: {
      "monthly": { link: HUBLA_LINK_BR_MONTHLY, label: "Mensal", price_display: "R$ 39,99" },
      "quarterly": { link: HUBLA_LINK_BR_QUARTERLY, label: "Trimestral", price_display: "R$ 99,99" },
      "semiannual": { link: HUBLA_LINK_BR_SEMIANNUAL, label: "Semestral", price_display: "R$ 189,99" }
    },
    allowed_country: "BR" // ✅ País permitido para este grupo
  },
  "int": {
    group_id: GROUP_ID_INT, // Mantido para referência
    welcome_message: "✅ Click the link to complete your Hubla subscription and join VIP INTERNATIONAL:",
    plans: {
      "monthly": { link: HUBLA_LINK_INT_MONTHLY, label: "Monthly", price_display: "€ 7,99" },
      "quarterly": { link: HUBLA_LINK_INT_QUARTERLY, label: "Quarterly", price_display: "€ 20,99" },
      "semiannual": { link: HUBLA_LINK_INT_SEMIANNUAL, label: "Semiannual", price_display: "€ 36,99" }
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

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }));

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
            [{ text: "🌍 VIP INTERNACIONAL", callback_data: "show_plans_int" }],
            [{ text: "💖 Meu Privacy", url: PRIVACY_PROFILE_URL }] // ✅ Botão Privacy
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

      // ✅ Redireciona para o link do Hubla
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: config.welcome_message,
        reply_markup: {
          inline_keyboard: [
            [{ text: `👉 Assinar ${plan.label} ${groupKey.toUpperCase()}`, url: plan.link }]
          ]
        }
      })
    }

    res.sendStatus(200)
  } catch (error) {
    console.error("Erro Telegram:", error.message)
    res.sendStatus(200)
  }
})

// ─────────────────────────────────────────
// WEBHOOKS (REMOVIDOS - Hubla gerencia)
// ─────────────────────────────────────────
// O Hubla gerencia a entrada e saída dos membros diretamente. 
// Não precisamos mais de um endpoint de webhook para Stripe/CCBill aqui.

app.listen(PORT, () => console.log("Server running on port " + PORT))
app.listen(PORT, () => console.log("Server running on port " + PORT))


