const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const mongoose = require("mongoose");
const { google } = require("googleapis");

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

// PAGAMENTO
const LIVEPIX_URL = process.env.LIVEPIX_URL?.trim() || "Chave Pix não configurada";
const CRIPTO_WALLET_USDT_TRON = "TRcZMiKsHDWnjTPpDpTzX9iC9y2Rd12u2b"; // Carteira USDT (Tron)

// GOOGLE SHEETS (SUPORTE A JSON)
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID?.trim() || "";
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;

let googleAuthData = {
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() || "",
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim() || ""
};

// Se o JSON estiver presente, extrai os dados dele
if (GOOGLE_CREDENTIALS_JSON) {
  try {
    const creds = JSON.parse(GOOGLE_CREDENTIALS_JSON);
    googleAuthData.email = creds.client_email;
    googleAuthData.key = creds.private_key.replace(/\\n/g, "\n");
    console.log("Credenciais do Google carregadas via JSON com sucesso!");
  } catch (e) {
    console.error("Erro ao processar GOOGLE_CREDENTIALS_JSON:", e.message);
  }
}

// MIDDLEWARES
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ROTA DE TESTE
app.get("/", (req, res) => {
  res.send(`<h1>Bot VIP Ativo!</h1><p>Status: Suporte a Credenciais JSON habilitado.</p>`);
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

    // 2. Voltar para o Início
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

    // 3. Escolha de Grupo
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

    // 4. Seleção de Plano -> Método de Pagamento
    if (callbackData && callbackData.startsWith("sel_")) {
      const parts = callbackData.split("_");
      const groupKey = parts[1];
      const planShortKey = parts[2];
      
      await editMessage(chatId, messageId, "Escolha o método de pagamento preferido:", {
        inline_keyboard: [
          [{ text: "LivePix (Pix)", callback_data: `pay_${groupKey}_${planShortKey}_pix` }],
          [{ text: "USDT (Rede Tron)", callback_data: `pay_${groupKey}_${planShortKey}_crypto` }],
          [{ text: "⬅️ Voltar", callback_data: `p_${groupKey}` }]
        ]
      });
      return;
    }

    // 5. Finalização de Escolha
    if (callbackData && callbackData.startsWith("pay_")) {
      const parts = callbackData.split("_");
      const groupKey = parts[1];
      const planShortKey = parts[2];
      const method = parts[3];
      
      const config = getPlansConfig();
      const plan = config[groupKey].plans[planShortKey];
      const groupName = groupKey === "br" ? "VIP BR 🇧🇷" : "VIP INT 🌎";
      const keyMap = { 'm': 'monthly', 'q': 'quarterly', 's': 'semiannual' };
      const planKey = keyMap[planShortKey] || planShortKey;
      
      let instr = `📦 *Plano Selecionado:* ${groupName} - ${plan.label}\n💰 *Valor:* ${plan.price_display}\n\n`;
      if (method === "pix") {
        instr += `💎 *Metodo:* LivePix (Pix)\n🔗 [Clique aqui para pagar](${LIVEPIX_URL})\n\n`;
      } else {
        instr += `💎 *Metodo:* USDT (Rede Tron)\n🔗 *Carteira:* \`${CRIPTO_WALLET_USDT_TRON}\`\n\n`;
      }
      instr += "Assim que a Manu visualizar o comprovante, ela ja libera seu acesso exclusivo!\n\n🕒 Horario de Atendimento: 09:00 as 22:00 todos os dias.\n\n*Por favor, envie o comprovante (Foto ou PDF) agora:*";

      await editMessage(chatId, messageId, instr, null);

      if (mongoose.connection.readyState === 1) {
        const PendingPayment = mongoose.model("PendingPayment");
        await PendingPayment.findByIdAndUpdate(chatId, { _id: chatId, userId, userName: username, groupKey, planKey, method, status: "awaiting_receipt" }, { upsert: true, new: true }).catch(e => console.log("Erro banco"));
      }
      return;
    }

    // 6. Recebimento de Comprovante
    if (message && (message.photo || message.document)) {
      if (mongoose.connection.readyState === 1) {
        const PendingPayment = mongoose.model("PendingPayment");
        const payment = await PendingPayment.findById(chatId);
        if (payment && payment.status === "awaiting_receipt") {
          await sendMessage(chatId, "Comprovante recebido com sucesso! Agora e so aguardar a Manu dar aquela conferida e seu link chegara aqui. Fique tranquilo(a), ela faz as liberacoes todos os dias das 09:00 as 22:00.");
          if (OWNER_TELEGRAM_ID) {
            const config = getPlansConfig();
            const plan = config[payment.groupKey]?.plans[payment.planKey === 'monthly' ? 'm' : payment.planKey === 'quarterly' ? 'q' : 's'];
            const groupName = payment.groupKey === "br" ? "VIP BR 🇧🇷" : "VIP INT 🌎";
            let adminMsg = `🔔 *NOVO COMPROVANTE*\n👤 @${username}\n🆔 \`${chatId}\`\n📦 ${groupName} - ${plan?.label}\n💰 ${plan?.price_display}\n\n/aprovar ${chatId}\n/reprovar ${chatId} <motivo>`;
            await sendMessage(OWNER_TELEGRAM_ID, adminMsg);
            await axios.post(`${TELEGRAM_API}/forwardMessage`, { chat_id: OWNER_TELEGRAM_ID, from_chat_id: chatId, message_id: message.message_id }).catch(e => console.log("Erro forward"));
          }
        }
      }
      return;
    }

    // 7. Comandos Admin
    if (text && text.startsWith("/aprovar")) await handleApproval(chatId, userId, text);
    if (text && text.startsWith("/reprovar")) await handleRejection(chatId, userId, text);
    if (text && text.startsWith("/remover")) await handleRemoval(chatId, userId, text);
    if (message && message.caption && message.caption.startsWith("/postar")) await handleGlobalPost(chatId, userId, message);

  } catch (err) { console.error("Erro no webhook:", err.message); }
});

// --- FUNÇÕES ADMIN --- //

async function handleApproval(adminChatId, adminUserId, text) {
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

    const r = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, { chat_id: groupId, member_limit: 1, expire_date: Math.floor(Date.now() / 1000) + 1800 });
    const invite = r.data.result.invite_link;

    const expires = new Date(Date.now() + plan.days * 86400000);
    await Subscription.findByIdAndUpdate(payment.userId, { _id: payment.userId, userId: payment.userId, chatId: clientId, groupKey: payment.groupKey, planKey: payment.planKey, expiresAt: expires, status: "active" }, { upsert: true });

    await sendMessage(clientId, "Pagamento aprovado! Clique no botao para entrar no grupo:", { inline_keyboard: [[{ text: "Entrar no grupo", url: invite }]] });
    
    // Registrar no Sheets
    const activatedAt = new Date().toLocaleString("pt-BR");
    const expiresAtStr = expires.toLocaleString("pt-BR");
    const daysRemaining = plan.days;
    const method = payment.method === "pix" ? "LivePix (Pix)" : "USDT (Rede Tron)";
    
    await appendToSheets([
      payment.userId, 
      payment.userName, 
      payment.groupKey.toUpperCase(), 
      plan.label, 
      activatedAt, 
      expiresAtStr, 
      daysRemaining, 
      "ATIVO", 
      method
    ], "Assinaturas");

    await PendingPayment.deleteOne({ _id: clientId });
    await sendMessage(adminChatId, `Sucesso! @${payment.userName} aprovado.`);
  } catch (e) { await sendMessage(adminChatId, "Erro na aprovacao. Verifique permissoes."); }
}

async function handleRejection(adminChatId, adminUserId, text) {
  if (adminUserId.toString() !== OWNER_TELEGRAM_ID) return;
  const parts = text.split(" ");
  if (parts.length < 2) return await sendMessage(adminChatId, "Use: /reprovar <ID> <Motivo>");
  const clientId = parts[1];
  const reason = parts.slice(2).join(" ") || "Comprovante invalido ou pagamento nao recebido.";

  try {
    const PendingPayment = mongoose.model("PendingPayment");
    const payment = await PendingPayment.findById(clientId);
    if (!payment) return await sendMessage(adminChatId, "ID nao encontrado.");

    await sendMessage(clientId, `❌ *Pagamento Reprovado*\n\nMotivo: ${reason}\n\nPor favor, envie o comprovante correto ou entre em contato.`);
    await sendMessage(adminChatId, `Sucesso! @${payment.userName} reprovado.`);
  } catch (e) { await sendMessage(adminChatId, "Erro ao reprovar."); }
}

async function handleRemoval(adminChatId, adminUserId, text) {
  if (adminUserId.toString() !== OWNER_TELEGRAM_ID) return;
  const parts = text.split(" ");
  if (parts.length < 2) return await sendMessage(adminChatId, "Use: /remover <ID>");
  const clientId = parts[1];

  try {
    const Subscription = mongoose.model("Subscription");
    const sub = await Subscription.findById(clientId);
    if (!sub) return await sendMessage(adminChatId, "Assinatura nao encontrada.");

    const config = getPlansConfig();
    const groupId = config[sub.groupKey]?.group_id;

    // Remover do grupo Telegram
    await axios.post(`${TELEGRAM_API}/banChatMember`, { chat_id: groupId, user_id: clientId }).catch(e => console.log("Erro ban"));
    await axios.post(`${TELEGRAM_API}/unbanChatMember`, { chat_id: groupId, user_id: clientId, only_if_banned: true }).catch(e => console.log("Erro unban"));

    // Registrar na aba Removidos
    const removalDate = new Date().toLocaleString("pt-BR");
    await appendToSheets([clientId, sub.groupKey.toUpperCase(), removalDate], "Removidos");

    // Atualizar status no banco
    await Subscription.findByIdAndUpdate(clientId, { status: "expired" });

    await sendMessage(clientId, "Sua assinatura expirou ou foi encerrada. Caso queira renovar, use /start.");
    await sendMessage(adminChatId, `Sucesso! Usuário ${clientId} removido e registrado na planilha.`);
  } catch (e) { await sendMessage(adminChatId, "Erro ao remover usuário."); }
}

async function handleGlobalPost(adminChatId, adminUserId, message) {
  if (adminUserId.toString() !== OWNER_TELEGRAM_ID) return;
  
  if (!message.photo) {
    return await sendMessage(adminChatId, "Para postar, envie uma FOTO com a legenda:\n\n`/postar` \n`PT: Seu texto em português` \n`EN: Your text in English`.");
  }

  const fullCaption = message.caption || "";
  const photoId = message.photo[message.photo.length - 1].file_id;

  // Extrair textos usando prefixos PT: e EN:
  let ptText = "";
  let enText = "";

  const ptMatch = fullCaption.match(/PT:\s*([\s\S]*?)(?=EN:|$)/i);
  const enMatch = fullCaption.match(/EN:\s*([\s\S]*?)(?=PT:|$)/i);

  if (ptMatch) ptText = ptMatch[1].trim();
  if (enMatch) enText = enMatch[1].trim();

  // Se não encontrar prefixos, tenta pegar o texto após o comando como padrão para ambos
  if (!ptText && !enText) {
    const fallbackText = fullCaption.replace("/postar", "").trim();
    ptText = fallbackText;
    enText = fallbackText;
  }

  try {
    const config = getPlansConfig();
    
    // Postar no BR
    if (VIP_BR_GROUP_ID && ptText) {
      await axios.post(`${TELEGRAM_API}/sendPhoto`, {
        chat_id: VIP_BR_GROUP_ID,
        photo: photoId,
        caption: ptText,
        parse_mode: "Markdown"
      });
    }

    // Postar no INT
    if (VIP_INT_GROUP_ID && enText) {
      await axios.post(`${TELEGRAM_API}/sendPhoto`, {
        chat_id: VIP_INT_GROUP_ID,
        photo: photoId,
        caption: enText,
        parse_mode: "Markdown"
      });
    }

    await sendMessage(adminChatId, `✅ Postagem bilíngue realizada com sucesso!`);
  } catch (e) {
    console.error("Erro na postagem global:", e.message);
    await sendMessage(adminChatId, "❌ Erro ao realizar a postagem. Verifique se o bot é admin nos grupos.");
  }
}

// --- GOOGLE SHEETS --- //

async function appendToSheets(rowData, sheetName = "Assinaturas") {
  if (!GOOGLE_SHEETS_ID || !googleAuthData.email || !googleAuthData.key) {
    console.log("Configuração de Sheets incompleta.");
    return;
  }
  try {
    const auth = new google.auth.JWT(googleAuthData.email, null, googleAuthData.key, ["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: "v4", auth });
    
    const range = sheetName === "Assinaturas" ? "Assinaturas!A:I" : "Removidos!A:C";
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: range,
      valueInputOption: "USER_ENTERED",
      resource: { values: [rowData] }
    });
    console.log(`Sheets (${sheetName}) atualizado!`);
  } catch (e) { console.error(`Erro Sheets (${sheetName}):`, e.message); }
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
  } catch (e) { await sendMessage(chatId, text, reply_markup); }
}

async function connectServices() {
  try {
    if (MONGODB_URI) {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      const schemaP = new mongoose.Schema({ _id: Number, userId: Number, userName: String, groupKey: String, planKey: String, method: String, status: String, timestamp: { type: Date, default: Date.now } });
      const schemaS = new mongoose.Schema({ _id: Number, userId: Number, chatId: Number, groupKey: String, planKey: String, expiresAt: Date, status: String });
      if (!mongoose.models.PendingPayment) mongoose.model("PendingPayment", schemaP);
      if (!mongoose.models.Subscription) mongoose.model("Subscription", schemaS);
    }
    if (WEBHOOK_BASE_URL && BOT_TOKEN) await axios.get(`${TELEGRAM_API}/setWebhook?url=${WEBHOOK_BASE_URL}/telegram`);
  } catch (e) {}
}

app.listen(PORT, "0.0.0.0", () => { connectServices(); });
