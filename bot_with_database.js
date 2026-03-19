const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const mongoose = require("mongoose");
const { google } = require("googleapis");
const crypto = require("crypto");

// Importar SDK do Mercado Pago
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIGURAÇÕES TELEGRAM =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID?.trim() || "";
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL?.trim() || "";
const MONGODB_URI = process.env.MONGODB_URI?.trim() || "";
const PRIVACY_PROFILE_URL = process.env.PRIVACY_PROFILE_URL?.trim() || "https://privacy.com.br/profile/manubellucciofc";
const VIP_BR_GROUP_ID = process.env.GROUP_ID_BR?.trim() || "";
const VIP_INT_GROUP_ID = process.env.GROUP_ID_INT?.trim() || "";

// ===== CONFIGURAÇÕES MERCADO PAGO =====
const MP_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN?.trim() || "";
const MP_WEBHOOK_SECRET = process.env.MERCADO_PAGO_WEBHOOK_SECRET?.trim() || "";

// Inicializar Mercado Pago
const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

// ===== CONFIGURAÇÕES GOOGLE SHEETS =====
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID?.trim() || "";
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;

let googleAuthData = {
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() || "",
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim() || ""
};

if (GOOGLE_CREDENTIALS_JSON) {
  try {
    const creds = JSON.parse(GOOGLE_CREDENTIALS_JSON);
    googleAuthData.email = creds.client_email;
    googleAuthData.key = creds.private_key.replace(/\\n/g, "\n");
    console.log("✅ Credenciais do Google carregadas com sucesso!");
  } catch (e) {
    console.error("❌ Erro ao processar GOOGLE_CREDENTIALS_JSON:", e.message);
  }
}

// ===== MIDDLEWARES =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== ROTAS =====

app.get("/", (req, res) => {
  res.send(`<h1>✅ Bot VIP Ativo!</h1><p>Integração com Mercado Pago habilitada.</p>`);
});

// ===== WEBHOOK DO TELEGRAM =====
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

    // --- COMANDO /start ---
    if (text && text.startsWith("/start")) {
      await sendMessage(chatId, "👋 Bem-vindo! Escolha seu grupo VIP:", {
        inline_keyboard: [
          [{ text: "VIP BR 🇧🇷", callback_data: "p_br" }],
          [{ text: "VIP INT 🌎", callback_data: "p_int" }],
          [{ text: "Acessar meu Privacy 🔥", url: PRIVACY_PROFILE_URL }]
        ]
      });
      return;
    }

    // --- CALLBACKS (BOTÕES) ---
    if (callbackData) {
      if (callbackData === "back") {
        await editMessage(chatId, messageId, "👋 Escolha seu grupo VIP:", {
          inline_keyboard: [
            [{ text: "VIP BR 🇧🇷", callback_data: "p_br" }],
            [{ text: "VIP INT 🌎", callback_data: "p_int" }],
            [{ text: "Acessar meu Privacy 🔥", url: PRIVACY_PROFILE_URL }]
          ]
        });
        return;
      }

      // Selecionar grupo
      if (callbackData === "p_br" || callbackData === "p_int") {
        const groupKey = callbackData.split("_")[1];
        const config = getPlansConfig();
        const groupConfig = config[groupKey];
        const keyboard = Object.keys(groupConfig.plans).map(key => ([{
          text: `${groupConfig.plans[key].label} - ${groupConfig.plans[key].price_display}`,
          callback_data: `sel_${groupKey}_${key}`
        }]));
        keyboard.push([{ text: "⬅️ Voltar", callback_data: "back" }]);
        await editMessage(chatId, messageId, "📦 Escolha seu plano:", { inline_keyboard: keyboard });
        return;
      }

      // Selecionar plano e gerar link de pagamento
      if (callbackData.startsWith("sel_")) {
        const parts = callbackData.split("_");
        const groupKey = parts[1];
        const planShortKey = parts[2];
        const config = getPlansConfig();
        const plan = config[groupKey]?.plans[planShortKey];
        const groupName = groupKey === "br" ? "VIP BR 🇧🇷" : "VIP INT 🌎";

        if (!plan) {
          await editMessage(chatId, messageId, "❌ Plano não encontrado.", null);
          return;
        }

        // Gerar link de pagamento do Mercado Pago
        const paymentLink = await createMercadoPagoPayment(
          chatId,
          userId,
          username,
          groupKey,
          planShortKey,
          plan
        );

        if (paymentLink) {
          const instr = `📦 *Plano Selecionado:* ${groupName} - ${plan.label}\n💰 *Valor:* ${plan.price_display}\n\n🔗 [Clique aqui para pagar](${paymentLink})`;
          await editMessage(chatId, messageId, instr, null);
        } else {
          await editMessage(chatId, messageId, "❌ Erro ao gerar link de pagamento. Tente novamente.", null);
        }
        return;
      }
    }

  } catch (err) {
    console.error("❌ Erro no webhook do Telegram:", err.message);
  }
});

// ===== WEBHOOK DO MERCADO PAGO =====
app.post("/webhook/mercadopago", async (req, res) => {
  res.sendStatus(200); // Responder imediatamente

  try {
    const { data, type } = req.body;

    console.log("📨 Webhook recebido do Mercado Pago:", { type, dataId: data?.id });

    // Validar assinatura do webhook
    if (!validateMercadoPagoSignature(req)) {
      console.log("⚠️ Assinatura do Mercado Pago inválida");
      return;
    }

    // Processar apenas notificações de pagamento
    if (type === "payment" && data?.id) {
      const paymentId = data.id;

      // Obter detalhes do pagamento
      const payment = new Payment(mpClient);
      const paymentData = await payment.get({ id: paymentId });

      console.log("💳 Detalhes do pagamento:", { id: paymentId, status: paymentData.status });

      // Verificar se o pagamento foi aprovado
      if (paymentData.status === "approved") {
        // Extrair dados do pagamento
        const externalReference = paymentData.external_reference; // "chatId_userId_groupKey_planKey"
        const [chatId, userId, groupKey, planKey] = externalReference.split("_");

        console.log("✅ Pagamento aprovado! Liberando acesso...", { chatId, userId, groupKey, planKey });

        // Liberar acesso automaticamente
        await liberarAcessoAutomatico(chatId, userId, groupKey, planKey);
      }
    }
  } catch (err) {
    console.error("❌ Erro no webhook do Mercado Pago:", err.message);
  }
});

// ===== FUNÇÕES DO MERCADO PAGO =====

async function createMercadoPagoPayment(chatId, userId, username, groupKey, planShortKey, plan) {
  try {
    const preference = new Preference(mpClient);

    // Mapa de moedas
    const currencyMap = {
      br: "BRL",
      int: "USD"
    };

    // Extrair valor numérico (ex: "R$ 29,90" → 29.90)
    const priceValue = parseFloat(plan.price_display.replace(/[^\d,.-]/g, "").replace(",", "."));

    const body = {
      items: [
        {
          id: `${groupKey}_${planShortKey}`,
          title: `${groupKey === "br" ? "VIP BR" : "VIP INT"} - ${plan.label}`,
          description: `Acesso por ${plan.days} dias`,
          picture_url: "https://via.placeholder.com/150",
          category_id: "services",
          quantity: 1,
          currency_id: currencyMap[groupKey],
          unit_price: priceValue
        }
      ],
      payer: {
        email: `user_${userId}@telegram.local`,
        name: username
      },
      external_reference: `${chatId}_${userId}_${groupKey}_${planShortKey}`,
      back_urls: {
        success: `${WEBHOOK_BASE_URL}/success`,
        failure: `${WEBHOOK_BASE_URL}/failure`,
        pending: `${WEBHOOK_BASE_URL}/pending`
      },
      auto_return: "approved",
      notification_url: `${WEBHOOK_BASE_URL}/webhook/mercadopago`
    };

    const response = await preference.create({ body });
    console.log("✅ Link de pagamento gerado:", response.init_point);
    return response.init_point; // Link de pagamento
  } catch (err) {
    console.error("❌ Erro ao criar pagamento:", err.message);
    return null;
  }
}

function validateMercadoPagoSignature(req) {
  try {
    const xSignature = req.headers["x-signature"];
    const xRequestId = req.headers["x-request-id"];

    if (!xSignature || !xRequestId) {
      console.log("⚠️ Headers de assinatura ausentes");
      return false;
    }

    const parts = xSignature.split(",");
    let ts = null;
    let hash = null;

    for (const part of parts) {
      const [key, value] = part.split("=");
      if (key === "ts") ts = value;
      if (key === "v1") hash = value;
    }

    if (!ts || !hash) {
      console.log("⚠️ Timestamp ou hash ausentes");
      return false;
    }

    // Construir manifest
    const dataId = req.body.data?.id || "";
    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;

    // Gerar HMAC
    const sha = crypto.createHmac("sha256", MP_WEBHOOK_SECRET).update(manifest).digest("hex");

    const isValid = sha === hash;
    console.log(`🔐 Validação de assinatura: ${isValid ? "✅ OK" : "❌ FALHOU"}`);
    return isValid;
  } catch (err) {
    console.error("❌ Erro ao validar assinatura:", err.message);
    return false;
  }
}

async function liberarAcessoAutomatico(chatId, userId, groupKey, planKey) {
  try {
    if (mongoose.connection.readyState !== 1) {
      console.log("⚠️ MongoDB offline");
      return;
    }

    const config = getPlansConfig();
    const plan = config[groupKey]?.plans[planKey === 'monthly' ? 'm' : planKey === 'quarterly' ? 'q' : 's'];
    const groupId = config[groupKey]?.group_id;

    if (!plan || !groupId) {
      console.log("⚠️ Plano ou grupo não encontrado");
      return;
    }

    // Criar link de convite único
    const inviteResponse = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, {
      chat_id: groupId,
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 1800 // Expira em 30 minutos
    });

    const inviteLink = inviteResponse.data.result.invite_link;

    // Salvar assinatura no MongoDB
    const Subscription = mongoose.model("Subscription");
    const expiresAt = new Date(Date.now() + plan.days * 86400000);

    await Subscription.findByIdAndUpdate(
      userId,
      {
        _id: userId,
        userId: userId,
        chatId: chatId,
        groupKey: groupKey,
        planKey: planKey,
        expiresAt: expiresAt,
        status: "active"
      },
      { upsert: true }
    );

    // Enviar link para o usuário
    await sendMessage(
      chatId,
      `✅ *Acesso Liberado!*\n\nClique no botão abaixo para entrar:`,
      {
        inline_keyboard: [[{ text: "Entrar no Grupo", url: inviteLink }]]
      }
    );

    // Salvar na planilha Google Sheets
    const activatedAt = new Date().toLocaleString("pt-BR");
    const expiresAtStr = expiresAt.toLocaleString("pt-BR");
    const daysRemaining = plan.days;

    await appendToSheets(
      [userId, "User_" + userId, groupKey.toUpperCase(), plan.label, activatedAt, expiresAtStr, daysRemaining, "ATIVO", "Mercado Pago"],
      "Assinaturas"
    );

    console.log(`✅ Acesso liberado para usuário ${userId}`);

    // Notificar admin (opcional)
    if (OWNER_TELEGRAM_ID) {
      await sendMessage(
        OWNER_TELEGRAM_ID,
        `✅ *PAGAMENTO CONFIRMADO*\n👤 User ${userId}\n📦 ${groupKey.toUpperCase()} - ${plan.label}\n💰 ${plan.price_display}\n\n✨ Acesso liberado automaticamente!`
      );
    }
  } catch (err) {
    console.error("❌ Erro ao liberar acesso:", err.message);
  }
}

// ===== FUNÇÕES AUXILIARES =====

function getPlansConfig() {
  return {
    br: {
      group_id: VIP_BR_GROUP_ID,
      plans: {
        m: { label: "Mensal", price_display: "R$ 29,90", days: 30 },
        q: { label: "Trimestral", price_display: "R$ 76,24", days: 90 },
        s: { label: "Semestral", price_display: "R$ 134,55", days: 180 }
      }
    },
    int: {
      group_id: VIP_INT_GROUP_ID,
      plans: {
        m: { label: "Monthly", price_display: "$11", days: 30 },
        q: { label: "Quarterly", price_display: "$28", days: 90 },
        s: { label: "Semiannual", price_display: "$49", days: 180 }
      }
    }
  };
}

async function sendMessage(chatId, text, reply_markup = null) {
  try {
    const payload = { chat_id: chatId, text: text, parse_mode: "Markdown" };
    if (reply_markup) payload.reply_markup = reply_markup;
    await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
  } catch (e) {
    console.error("❌ Erro ao enviar mensagem:", e.message);
  }
}

async function editMessage(chatId, messageId, text, reply_markup = null) {
  try {
    const payload = { chat_id: chatId, message_id: messageId, text: text, parse_mode: "Markdown" };
    if (reply_markup) payload.reply_markup = reply_markup;
    await axios.post(`${TELEGRAM_API}/editMessageText`, payload);
  } catch (e) {
    await sendMessage(chatId, text, reply_markup);
  }
}

async function appendToSheets(rowData, sheetName = "Assinaturas") {
  if (!GOOGLE_SHEETS_ID || !googleAuthData.email || !googleAuthData.key) return;
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
    console.log(`✅ Dados salvos na planilha (${sheetName})`);
  } catch (e) {
    console.error(`❌ Erro Sheets (${sheetName}):`, e.message);
  }
}

async function connectServices() {
  try {
    console.log("🔄 Conectando serviços...");

    if (MONGODB_URI) {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      const schemaP = new mongoose.Schema({
        _id: Number,
        userId: Number,
        userName: String,
        groupKey: String,
        planKey: String,
        method: String,
        status: String,
        timestamp: { type: Date, default: Date.now }
      });
      const schemaS = new mongoose.Schema({
        _id: Number,
        userId: Number,
        chatId: Number,
        groupKey: String,
        planKey: String,
        expiresAt: Date,
        status: String
      });
      if (!mongoose.models.PendingPayment) mongoose.model("PendingPayment", schemaP);
      if (!mongoose.models.Subscription) mongoose.model("Subscription", schemaS);
      console.log("✅ MongoDB conectado");
    }

    if (WEBHOOK_BASE_URL && BOT_TOKEN) {
      await axios.get(`${TELEGRAM_API}/setWebhook?url=${WEBHOOK_BASE_URL}/telegram`);
      console.log("✅ Webhook do Telegram configurado");
    }

    if (MP_ACCESS_TOKEN) {
      console.log("✅ Mercado Pago configurado");
    }

    console.log("✅ Todos os serviços conectados!");
  } catch (e) {
    console.error("❌ Erro ao conectar serviços:", e.message);
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  connectServices();
});
