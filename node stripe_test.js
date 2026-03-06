const Stripe = require("stripe");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!STRIPE_SECRET_KEY) {
  console.error("ERRO: A variável de ambiente STRIPE_SECRET_KEY não está definida.");
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
  timeout: 20000, // 20 segundos
  maxNetworkRetries: 2
});

async function testStripeConnection() {
  console.log("Tentando conectar ao Stripe com a chave: " + STRIPE_SECRET_KEY.substring(0, 10) + "...");
  try {
    // Tenta listar os produtos como um teste de conexão
    const products = await stripe.products.list({ limit: 1 });
    console.log("✅ Conexão com o Stripe bem-sucedida!");
    console.log("Primeiro produto encontrado (se houver):", products.data[0] ? products.data[0].name : "Nenhum produto.");
  } catch (error) {
    console.error("❌ Erro ao conectar ou autenticar com o Stripe:");
    console.error("Mensagem de erro: ", error.message);
    if (error.raw && error.raw.code) {
      console.error("Código de erro do Stripe: ", error.raw.code);
    }
    if (error.raw && error.raw.param) {
      console.error("Parâmetro relacionado: ", error.raw.param);
    }
    if (error.statusCode) {
      console.error("Status HTTP: ", error.statusCode);
    }
  }
}

testStripeConnection();
