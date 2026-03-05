const express = require("express");
const Stripe = require("stripe");
const TelegramBot = require("node-telegram-bot-api");
const bodyParser = require("body-parser");

const app = express();

app.use(bodyParser.raw({ type: 'application/json' }));

const stripe = Stripe(process.env.STRIPE_SECRET);
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

const groupId = process.env.GROUP_ID;

app.post("/webhook", async (req, res) => {

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send("Webhook error");
  }

  if (event.type === "checkout.session.completed") {

    const session = event.data.object;
    const telegramId = session.client_reference_id;

    const invite = await bot.createChatInviteLink(groupId, {
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 3600
    });

    await bot.sendMessage(
      telegramId,
      "Pagamento confirmado! Entre no grupo VIP:\n" + invite.invite_link
    );
  }

  res.json({ received: true });
});

app.listen(3000, () => {
  console.log("Servidor rodando");
});

