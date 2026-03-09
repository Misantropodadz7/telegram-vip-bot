const express = require("express")
const bodyParser = require("body-parser")
const axios = require("axios")
const crypto = require("crypto")
const https = require("https");

const app = express()
const PORT = process.env.PORT || 8080
const BOT_TOKEN = process.env.BOT_TOKEN

// ✅ Variáveis para múltiplos grupos
const GROUP_ID_BR = process.env.GROUP_ID_BR
const GROUP_ID_INT = process.env.GROUP_ID_INT

// ✅ Variáveis da Cryptomus
const CRYPTOMUS_MERCHANT_ID = process.env.CRYPTOMUS_MERCHANT_ID ? process.env.CRYPTOMUS_MERCHANT_ID.trim() : "";
const CRYPTOMUS_API_KEY = process.env.CRYPTOMUS_API_KEY ? process.env.CRYPTOMUS_API_KEY.trim() : "";
const CRYPTOMUS_API_URL = "https://api.cryptomus.com/v1";

// ✅ URL do perfil Privacy
const PRIVACY_PROFILE_URL = process.env.PRIVACY_PROFILE_URL ? process.env.PRIVACY_PROFILE_URL.trim() : "";

// ✅ Variável para a chave da API de Geolocalização (se usar uma versão paga)
const IP_API_KEY = process.env.IP_API_KEY || ""; // O ip-api.com funciona sem chave para uso básico

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

// ✅ Verificação inicial das variáveis de ambiente
if (!BOT_TOKEN || !GROUP_ID_BR || !GROUP_ID_INT || !PRIVACY_PROFILE_URL || !CRYPTOMUS_MERCHANT_ID || !CRYPTOMUS_API_KEY) {
  console.error("❌ ERRO: Variáveis essenciais (BOT_TOKEN, GROUP_ID_BR, GROUP_ID_INT, PRIVACY_PROFILE_URL, CRYPTOMUS_MERCHANT_ID, CRYPTOMUS_API_KEY) não foram definidas no Railway.");
  process.exit(1);
}

// ✅ Mapeamento de planos e grupos (agora com valores para Cryptomus)
const plansConfig = {
  "br": {
    group_id: GROUP_ID_BR,
    welcome_message: "✅ Clique no link para finalizar a assinatura e entrar no VIP BRASIL:",
    plans: {
      "monthly": { label: "Mensal", price_display: "R$ 29,90", cryptomus_amount: "29.90", cryptomus_currency: "BRL" },
      "quarterly": { label: "Trimestral", price_display: "R$ 76,24", cryptomus_amount: "76.24", cryptomus_currency: "BRL" },
      "semiannual": { label: "Semestral", price_display: "R$ 134,55", cryptomus_amount: "134.55", cryptomus_currency: "BRL" }
    },
    allowed_country: "BR" // ✅ País permitido para este grupo
  },
  "int": {
    group_id: GROUP_ID_INT,
    welcome_message: "✅ Click the link to complete your subscription and join VIP INTERNATIONAL:",
    plans: {
      "monthly": { label: "Monthly", price_display: "€ 7,99", cryptomus_amount: "7.99", cryptomus_currency: "EUR" },
      "quarterly": { label: "Quarterly", price_display: "€ 20,99", cryptomus_amount: "20.99", cryptomus_currency: "EUR" },
      "semiannual": { label: "Semiannual", price_display: "€ 36,99", cryptomus_amount: "36.99", cryptomus_currency: "EUR" }
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

// Middleware para verificar a assinatura do webhook da Cryptomus
const verifyCryptomusSignature = (req, res, next) => {
  const signature = req.headers["signature"];
  if (!signature) {
    console.warn("Webhook Cryptomus: Assinatura ausente.");
    return res.status(400).send("Signature missing");
  }

  const body = JSON.stringify(req.body);
  const hash = crypto.createHmac("sha512", CRYPTOMUS_API_KEY).update(body).digest("hex");

  if (hash !== signature) {
    console.warn("Webhook Cryptomus: Assinatura inválida.");
    return res.status(403).send("Invalid signature");
  }
  next();
};

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

      // ✅ Criação da fatura na Cryptomus
      try {
        const orderId = `${chatId}_${groupKey}_${planKey}_${Date.now()}`;
        const requestBody = {
          amount: plan.cryptomus_amount,
          currency: plan.cryptomus_currency,
          order_id: orderId,
          url_return: `https://t.me/${process.env.BOT_USERNAME || 'seu_bot_username'}`, // Substitua pelo username do seu bot
          url_callback: `${process.env.RAILWAY_STATIC_URL || 'https://SEU-DOMINIO-RAILWAY.up.railway.app'}/cryptomus-webhook`,
          extra_data: JSON.stringify({ chatId, groupKey, planKey })
        };

        const sign = crypto.createHmac("sha512", CRYPTOMUS_API_KEY).update(JSON.stringify(requestBody)).digest("hex");

        const cryptomusResponse = await axios.post(`${CRYPTOMUS_API_URL}/payment`, requestBody, {
          headers: {
            'merchant': CRYPTOMUS_MERCHANT_ID,
            'sign': sign,
            'Content-Type': 'application/json'
          }
        });

        const paymentUrl = cryptomusResponse.data.result.url;

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `💳 Pague aqui para entrar no VIP ${groupKey.toUpperCase()}:
${paymentUrl}`,
          reply_markup: {
            inline_keyboard: [
              [{ text: "Abrir Pagamento", url: paymentUrl }]
            ]
          }
        });

      } catch (cryptomusError) {
        console.error("Erro ao criar fatura Cryptomus:", cryptomusError.response ? cryptomusError.response.data : cryptomusError.message);
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Erro ao gerar o link de pagamento. Por favor, tente novamente mais tarde."
        });
      }
    }

    res.sendStatus(200)
  } catch (error) {
    console.error("Erro Telegram:", error.message)
    res.sendStatus(200)
  }
})

// ─────────────────────────────────────────
// WEBHOOK DA CRYPTOMUS
// ─────────────────────────────────────────
app.post("/cryptomus-webhook", verifyCryptomusSignature, async (req, res) => {
  const event = req.body;
  console.log("Webhook Cryptomus recebido:", event);

  if (event.type === "payment.update" && event.data.status === "paid") {
    try {
      const { chatId, groupKey } = JSON.parse(event.data.extra_data);
      const groupId = plansConfig[groupKey].group_id;

      // Gerar link de convite único
      const inviteLinkResponse = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, {
        chat_id: groupId,
        member_limit: 1,
        expire_date: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // Expira em 24 horas
      });
      const inviteLink = inviteLinkResponse.data.result.invite_link;

      // Enviar link de convite para o usuário
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `🎉 Pagamento confirmado! Bem-vindo(a) ao VIP ${groupKey.toUpperCase()}! Use este link para entrar no grupo (válido por 24h e 1 uso):
${inviteLink}`
      });

      console.log(`Usuário ${chatId} adicionado ao grupo ${groupId} via Cryptomus.`);

    } catch (error) {
      console.error("Erro ao processar webhook Cryptomus (adicionar membro):
", error.response ? error.response.data : error.message);
    }
  } else if (event.type === "payment.update" && (event.data.status === "cancelled" || event.data.status === "refunded")) {
    // ✅ Lógica para remover membro em caso de cancelamento/reembolso
    // ATENÇÃO: Cryptomus não tem um sistema de assinatura recorrente nativo como Stripe.
    // Para remoção automática após o fim da mensalidade, você precisaria de um sistema
    // externo que monitore a validade da assinatura e chame o bot para banir.
    // Este bloco é para pagamentos cancelados/reembolsados, não para fim de período.
    try {
      const { chatId, groupKey } = JSON.parse(event.data.extra_data);
      const groupId = plansConfig[groupKey].group_id;

      await axios.post(`${TELEGRAM_API}/banChatMember`, { chat_id: groupId, user_id: chatId });
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "❌ Seu pagamento foi cancelado/reembolsado e você foi removido do grupo VIP."
      });
      console.log(`Usuário ${chatId} removido do grupo ${groupId} via Cryptomus (cancelado/reembolsado).`);
    } catch (error) {
      console.error("Erro ao processar webhook Cryptomus (remover membro):
", error.response ? error.response.data : error.message);
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => console.log("Server running on port " + PORT))

