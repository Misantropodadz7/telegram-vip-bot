const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const mongoose = require("mongoose");

const app = express();
const PORT = process.env.PORT || 3000;

// TELEGRAM
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// VARIÁVEIS DE AMBIENTE
const OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID?.trim() || "";
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL?.trim() || "";
const MONGODB_URI = process.env.MONGODB_URI?.trim() || "";
const PRIVACY_PROFILE_URL = process.env.PRIVACY_PROFILE_URL?.trim() || "https://privacy.com.br/profile/manubellucciofc";
const VIP_BR_GROUP_ID = process.env.GROUP_ID_BR?.trim() || "";
const VIP_INT_GROUP_ID = process.env.GROUP_ID_INT?.trim() || "";

// MIDDLEWARES
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ROTA DE TESTE
app.get("/", (req, res) => {
  res.send(`<h1>Bot VIP Online!</h1><p>Status: Operacional.</p>`);
});

// TELEGRAM WEBHOOK
app.post("/telegram", async (req, res) => {
  const { message, callback_query } = req.body;
  res.sendStatus(200);

  try {
    const chatId = message?.chat?.id || callback_query?.message?.chat?.id;
    const userId = message?.from?.id || callback_query?.from?.id;
    const username = message?.from?.username || callback_query?.from?.username || "User";
    const text = message?.text || "";
    const callbackData = callback_query?.data;

    if (text || callbackData) {
      console.log(`>>> RECEBIDO: ${text || callbackData} de @${username} <<<`);
    }

    // 1. Comando /start
    if (text && text.startsWith("/start")) {
      await sendMessage(chatId, "Escolha seu grupo VIP ou acesse meu perfil no Privacy:", {
        inline_keyboard: [
          [{ text: "VIP BR 🇧🇷", callback_data: "p_br" }],
          [{ text: "VIP INT 🌎", callback_data: "p_int" }],
          [{ text: "Acessar meu Privacy 🔥", url: PRIVACY_PROFILE_URL }]
        ]
      });
      return;
    }

    // 2. Escolha de Grupo (BR ou INT)
    if (callbackData === "p_br" || callbackData === "p_int") {
      const groupKey = callbackData.split("_")[1]; // 'br' ou 'int'
      const config = getPlansConfig();
      const groupConfig = config[groupKey];
      
      const keyboard = Object.keys(groupConfig.plans).map(key => ([{
        text: `${groupConfig.plans[key].label} - ${groupConfig.plans[key].price_display}`,
        callback_data: `b_${groupKey}_${key}` // Ex: b_br_m, b_int_q
      }]));
      keyboard.push([{ text: "⬅️ Voltar", callback_data: "back" }]);
      
      await sendMessage(chatId, "Escolha seu plano:", { inline_keyboard: keyboard });
      return;
    }

    // 3. Voltar para o menu inicial
    if (callbackData === "back") {
      await sendMessage(chatId, "Escolha seu grupo VIP ou acesse meu perfil no Privacy:", {
        inline_keyboard: [
          [{ text: "VIP BR 🇧🇷", callback_data: "p_br" }],
          [{ text: "VIP INT 🌎", callback_data: "p_int" }],
          [{ text: "Acessar meu Privacy 🔥", url: PRIVACY_PROFILE_URL }]
        ]
      });
      return;
    }

    // 4. Clique no Plano (CHAVES CURTAS: b_br_m, b_br_q, b_br_s, b_int_m, b_int_q, b_int_s)
    if (callbackData && callbackData.startsWith("b_")) {
      const parts = callbackData.split("_");
      const groupKey = parts[1]; // 'br' ou 'int'
      const planShortKey = parts[2]; // 'm', 'q' ou 's'
      
      const keyMap = { 'm': 'monthly', 'q': 'quarterly', 's': 'semiannual' };
      const planKey = keyMap[planShortKey] || planShortKey;

      console.log(`[COMPRA] Grupo=${groupKey}, Plano=${planKey}`);

      // Resposta imediata ao cliente
      await sendMessage(chatId, "Por favor, envie o comprovante de pagamento (Foto ou PDF) aqui no chat.");

      // Salva no banco em segundo plano
      if (mongoose.connection.readyState === 1) {
        const PendingPayment = mongoose.model("PendingPayment");
        PendingPayment.findByIdAndUpdate(
          chatId,
          { _id: chatId, userId, userName: username, groupKey, planKey, status: "awaiting_receipt" },
          { upsert: true, new: true }
        ).catch(e => console.log("Erro banco silenciado"));
      }
      return;
    }

    // 5. Recebimento de Comprovante
    if (message && (message.photo || message.document)) {
      await sendMessage(chatId, "✅ Comprovante recebido!\n\n🕒 **Atendimento:** 09:00 às 22:00 todos os dias.\n\nAguarde, em breve seu acesso será liberado!");

      if (OWNER_TELEGRAM_ID) {
        await sendMessage(OWNER_TELEGRAM_ID, `🔔 NOVO COMPROVANTE\nUsuário: @${username}\nID: ${chatId}\n\nPara aprovar:\n\`/aprovar ${chatId}\``);
        await axios.post(`${TELEGRAM_API}/forwardMessage`, {
          chat_id: OWNER_TELEGRAM_ID,
          from_chat_id: chatId,
          message_id: message.message_id
        }).catch(e => console.log("Erro forward"));
      }
      return;
    }

    // 6. Aprovação
    if (text && text.startsWith("/aprovar")) {
      await handleApproval(chatId, userId, username, text);
    }

  } catch (err) {
    console.error("Erro no webhook:", err.message);
  }
});

// --- FUNÇÕES DE APOIO --- //

async function handleApproval(adminChatId, adminUserId, adminUsername, text) {
  if (adminUserId.toString() !== OWNER_TELEGRAM_ID) return;

  const parts = text.split(" ");
  if (parts.length < 2) return await sendMessage(adminChatId, "Use: /aprovar <ID>");

  const clientId = parts[1];
  if (mongoose.connection.readyState !== 1) return await sendMessage(adminChatId, "Banco offline.");

  try {
    const PendingPayment = mongoose.model("PendingPayment");
    const Subscription = mongoose.model("Subscription");
    const payment = await PendingPayment.findById(clientId);

    if (!payment) return await sendMessage(adminChatId, "ID não encontrado.");

    const config = getPlansConfig();
    const plan = config[payment.groupKey]?.plans[payment.planKey];
    const groupId = config[payment.groupKey]?.group_id;

    const r = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, {
      chat_id: groupId,
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 1800
    });
    const invite = r.data.result.invite_link;

    const expires = new Date(Date.now() + plan.days * 86400000);
    await Subscription.findByIdAndUpdate(
      payment.userId,
      { _id: payment.userId, userId: payment.userId, chatId: clientId, groupKey: payment.groupKey, planKey: payment.planKey, expiresAt: expires, status: "active" },
      { upsert: true }
    );

    await sendMessage(clientId, "✅ Pagamento aprovado!", { inline_keyboard: [[{ text: "Entrar no grupo", url: invite }]] });
    await PendingPayment.deleteOne({ _id: clientId });
    await sendMessage(adminChatId, `✅ @${payment.userName} aprovado!`);
  } catch (e) {
    await sendMessage(adminChatId, "Erro na aprovação. Verifique as permissões.");
  }
}

function getPlansConfig() {
  return {
    br: { group_id: VIP_BR_GROUP_ID, plans: { m: { label: "Mensal", price_display: "R$ 29,90", days: 30 }, q: { label: "Trimestral", price_display: "R$ 76,24", days: 90 }, s: { label: "Semestral", price_display: "R$ 134,55", days: 180 } } },
    int: { group_id: VIP_INT_GROUP_ID, plans: { m: { label: "Monthly", price_display: "$11", days: 30 }, q: { label: "Quarterly", price_display: "$28", days: 90 }, s: { label: "Semiannual", price_display: "$49", days: 180 } } }
  };
}

async function sendMessage(chatId, text, reply_markup = null) {
  try { await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, reply_markup, parse_mode: "Markdown" }); } catch (e) {}
}

async function connectServices() {
  try {
    if (MONGODB_URI) {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      const schemaP = new mongoose.Schema({ _id: Number, userId: Number, userName: String, groupKey: String, planKey: String, status: String, timestamp: { type: Date, default: Date.now } });
      const schemaS = new mongoose.Schema({ _id: Number, userId: Number, chatId: Number, groupKey: String, planKey: String, expiresAt: Date, status: String });
      if (!mongoose.models.PendingPayment) mongoose.model("PendingPayment", schemaP);
      if (!mongoose.models.Subscription) mongoose.model("Subscription", schemaS);
    }
    if (WEBHOOK_BASE_URL && BOT_TOKEN) await axios.get(`${TELEGRAM_API}/setWebhook?url=${WEBHOOK_BASE_URL}/telegram`);
  } catch (e) {}
}

app.listen(PORT, "0.0.0.0", () => { connectServices(); });
