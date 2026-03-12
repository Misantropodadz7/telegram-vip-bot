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

// PAGAMENTO (VARIÁVEIS)
const LIVEPIX_URL = process.env.LIVEPIX_URL?.trim() || "Chave Pix não configurada";
const CRIPTO_WALLET = process.env.CRIPTO_WALLET?.trim() || "Carteira Cripto não configurada";

// MIDDLEWARES
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ROTA DE TESTE
app.get("/", (req, res) => {
  res.send(`<h1>Bot VIP Interativo Online!</h1><p>Status: Operacional e Organizado.</p>`);
});

// TELEGRAM WEBHOOK
app.post("/telegram", async (req, res) => {
  const { message, callback_query } = req.body;
  res.sendStatus(200);

  try {
    const chatId = message?.chat?.id || callback_query?.message?.chat?.id;
    const messageId = message?.message_id || callback_query?.message?.message_id;
    const userId = message?.from?.id || callback_query?.from?.id;
    const username = message?.from?.username || callback_query?.from?.username || "User";
    const text = message?.text || "";
    const callbackData = callback_query?.data;

    if (text || callbackData) {
      console.log(`>>> RECEBIDO: ${text || callbackData} de @${username} <<<`);
    }

    // 1. Comando /start (Nova Mensagem Limpa)
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

    // 2. Voltar para o Início (Edita Mensagem)
    if (callbackData === "back") {
      await editMessage(chatId, messageId, "Escolha seu grupo VIP ou acesse meu perfil no Privacy:", {
        inline_keyboard: [
          [{ text: "VIP BR 🇧🇷", callback_data: "p_br" }],
          [{ text: "VIP INT 🌎", callback_data: "p_int" }],
          [{ text: "Acessar meu Privacy 🔥", url: PRIVACY_PROFILE_URL }]
        ]
      });
      return;
    }

    // 3. Escolha de Grupo (Edita Mensagem)
    if (callbackData === "p_br" || callbackData === "p_int") {
      const groupKey = callbackData.split("_")[1];
      const config = getPlansConfig();
      const groupConfig = config[groupKey];
      
      const keyboard = Object.keys(groupConfig.plans).map(key => ([{
        text: `${groupConfig.plans[key].label} - ${groupConfig.plans[key].price_display}`,
        callback_data: `sel_${groupKey}_${key}`
      }]));
      keyboard.push([{ text: "⬅️ Voltar", callback_data: "back" }]);
      
      await editMessage(chatId, messageId, "Escolha seu plano:", { inline_keyboard: keyboard });
      return;
    }

    // 4. Seleção de Plano -> Escolha de Método de Pagamento (Edita Mensagem)
    if (callbackData && callbackData.startsWith("sel_")) {
      const parts = callbackData.split("_");
      const groupKey = parts[1];
      const planShortKey = parts[2];
      
      await editMessage(chatId, messageId, "Escolha o método de pagamento preferido:", {
        inline_keyboard: [
          [{ text: "LivePix (Pix)", callback_data: `pay_${groupKey}_${planShortKey}_pix` }],
          [{ text: "Criptomoeda (Trust Wallet)", callback_data: `pay_${groupKey}_${planShortKey}_crypto` }],
          [{ text: "⬅️ Voltar", callback_data: `p_${groupKey}` }]
        ]
      });
      return;
    }

    // 5. Finalização de Escolha (TRAVA O FLUXO - Nova Mensagem com Instruções)
    if (callbackData && callbackData.startsWith("pay_")) {
      const parts = callbackData.split("_");
      const groupKey = parts[1];
      const planShortKey = parts[2];
      const method = parts[3];
      
      const keyMap = { 'm': 'monthly', 'q': 'quarterly', 's': 'semiannual' };
      const planKey = keyMap[planShortKey] || planShortKey;
      
      let instr = "";
      if (method === "pix") {
        instr = `💎 *Metodo: LivePix*\n\nEfetue o pagamento no link abaixo:\n🔗 ${LIVEPIX_URL}\n\n`;
      } else {
        instr = `💎 *Metodo: Criptomoeda*\n\nTransfira para a carteira abaixo:\n\`${CRIPTO_WALLET}\`\n\n`;
      }
      
      instr += "Assim que a Manu visualizar o comprovante, ela ja libera seu acesso exclusivo!\n\n🕒 Horario de Atendimento: 09:00 as 22:00 todos os dias.\n\n*Por favor, envie o comprovante (Foto ou PDF) agora:*";

      // Edita a mensagem removendo botões de voltar (Trava o fluxo)
      await editMessage(chatId, messageId, instr, null);

      // Salva no banco
      if (mongoose.connection.readyState === 1) {
        const PendingPayment = mongoose.model("PendingPayment");
        await PendingPayment.findByIdAndUpdate(
          chatId,
          { _id: chatId, userId, userName: username, groupKey, planKey, status: "awaiting_receipt" },
          { upsert: true, new: true }
        ).catch(e => console.log("Erro banco silenciado"));
      }
      return;
    }

    // 6. Recebimento de Comprovante
    if (message && (message.photo || message.document)) {
      await sendMessage(chatId, "Comprovante recebido com sucesso! Agora e so aguardar a Manu dar aquela conferida e seu link chegara aqui. Fique tranquilo(a), ela faz as liberacoes todos os dias das 09:00 as 22:00.");

      if (OWNER_TELEGRAM_ID) {
        await sendMessage(OWNER_TELEGRAM_ID, `🔔 NOVO COMPROVANTE\nUsuario: @${username}\nID: ${chatId}\nPara aprovar use: /aprovar ${chatId}`);
        await axios.post(`${TELEGRAM_API}/forwardMessage`, {
          chat_id: OWNER_TELEGRAM_ID,
          from_chat_id: chatId,
          message_id: message.message_id
        }).catch(e => console.log("Erro forward"));
      }
      return;
    }

    // 7. Aprovação
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
    if (!payment) return await sendMessage(adminChatId, "ID nao encontrado.");

    const config = getPlansConfig();
    const plan = config[payment.groupKey]?.plans[payment.planKey === 'monthly' ? 'm' : payment.planKey === 'quarterly' ? 'q' : 's'];
    const groupId = config[payment.groupKey]?.group_id;

    const r = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, {
      chat_id: groupId,
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 1800
    });
    const invite = r.data.result.invite_link;

    const expires = new Date(Date.now() + plan.days * 86400000);
    await Subscription.findByIdAndUpdate(payment.userId, { _id: payment.userId, userId: payment.userId, chatId: clientId, groupKey: payment.groupKey, planKey: payment.planKey, expiresAt: expires, status: "active" }, { upsert: true });

    await sendMessage(clientId, "Pagamento aprovado! Clique no botao para entrar no grupo:", { inline_keyboard: [[{ text: "Entrar no grupo", url: invite }]] });
    await PendingPayment.deleteOne({ _id: clientId });
    await sendMessage(adminChatId, `Sucesso! @${payment.userName} aprovado.`);
  } catch (e) {
    await sendMessage(adminChatId, "Erro na aprovacao. Verifique as permissoes.");
  }
}

function getPlansConfig() {
  return {
    br: { group_id: VIP_BR_GROUP_ID, plans: { m: { label: "Mensal", price_display: "R$ 29,90", days: 30 }, q: { label: "Trimestral", price_display: "R$ 76,24", days: 90 }, s: { label: "Semestral", price_display: "R$ 134,55", days: 180 } } },
    int: { group_id: VIP_INT_GROUP_ID, plans: { m: { label: "Monthly", price_display: "$11", days: 30 }, q: { label: "Quarterly", price_display: "$28", days: 90 }, s: { label: "Semiannual", price_display: "$49", days: 180 } } }
  };
}

async function sendMessage(chatId, text, reply_markup = null) {
  try { 
    const payload = { chat_id: chatId, text: text, parse_mode: "Markdown" };
    if (reply_markup) payload.reply_markup = reply_markup;
    await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
  } catch (e) {}
}

async function editMessage(chatId, messageId, text, reply_markup = null) {
  try {
    const payload = { chat_id: chatId, message_id: messageId, text: text, parse_mode: "Markdown" };
    if (reply_markup) payload.reply_markup = reply_markup;
    await axios.post(`${TELEGRAM_API}/editMessageText`, payload);
  } catch (e) {
    // Se não conseguir editar (ex: mensagem igual), tenta enviar uma nova
    await sendMessage(chatId, text, reply_markup);
  }
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
