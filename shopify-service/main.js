const axios = require("axios");
const OpenAI = require("openai");
require("dotenv").config();

// ------------------- CONFIG -------------------
const SHOPIFY_API_URL = process.env.SHOPIFY_API_URL;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION_NAME = "products";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SHOPIFY_API_URL || !SHOPIFY_ADMIN_TOKEN) {
  throw new Error("Errore: variabili d'ambiente SHOPIFY_API_URL e SHOPIFY_ADMIN_TOKEN non definite!");
}
if (!OPENAI_API_KEY) {
  throw new Error("Errore: variabile OPENAI_API_KEY non definita!");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ------------------- SHOPIFY -------------------
async function fetchShopify(query) {
  try {
    const response = await axios.post(
      SHOPIFY_API_URL,
      { query },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
        },
      }
    );

    if (response.data.errors) {
      console.error("Errori GraphQL:", JSON.stringify(response.data.errors, null, 2));
      throw new Error("Errore dalla Shopify GraphQL API");
    }

    return response.data.data.products;
  } catch (error) {
    console.error("Errore nella chiamata Shopify:", error.response?.data || error.message);
    throw error;
  }
}

async function getAllProducts(limit = 250) {
  let products = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage && products.length < limit) {
    const batchSize = Math.min(250, limit - products.length);
    const query = `
      {
        products(first: ${batchSize}${cursor ? `, after: "${cursor}"` : ""}) {
          edges {
            cursor
            node {
              id
              title
              description
              handle
              vendor
              productType
              tags
              status
              images(first: 1) {
                edges {
                  node {
                    originalSrc
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const data = await fetchShopify(query);
    products = products.concat(data.edges.map(edge => edge.node));
    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
  }

  return products;
}

// ------------------- OPENAI EMBEDDING -------------------
async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return response.data[0].embedding;
}

// ------------------- QDRANT -------------------
async function createCollection() {
  try {
    await axios.put(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
      vectors: { size: 1536, distance: "Cosine" },
    });
    console.log(`Collection '${COLLECTION_NAME}' creata o già esistente.`);
  } catch (error) {
    console.error("Errore creazione collection:", error.response?.data || error.message);
  }
}

async function insertProduct(product) {
  try {
    const tagsAsString = Array.isArray(product.tags) ? product.tags.join(", ") : product.tags || "";
    const textToEmbed = `
      Title: ${product.title || ""}
      Description: ${product.description || ""}
      Tags: ${tagsAsString}
    `;

    const vector = await generateEmbedding(textToEmbed);
    const qdrantId = parseInt(product.id.split("/").pop(), 10); // ID numerico di Shopify

    // Qui creiamo pageContent + metadata come due campi separati
    const payload = {
      pageContent: `${product.title || ""}. ${product.description || ""}. Tags: ${tagsAsString}`,
      metadata: {
        title: product.title,
        description: product.description,
        tags: product.tags,
      }
    };

    await axios.put(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points`, {
      points: [
        {
          id: qdrantId,
          vector: vector,
          payload: payload,
        },
      ],
    });

    console.log(`✔ Prodotto inserito: ${product.title}`);
  } catch (error) {
    console.error(`✖ Errore inserendo ${product.title}:`, error.response?.data || error.message);
  }
}

// ------------------- MAIN -------------------
async function syncProductsWithQdrant() {
  console.log("Recupero prodotti da Shopify...");
  const products = await getAllProducts();
  console.log(`Trovati ${products.length} prodotti. Creazione collection Qdrant...`);

  await createCollection();
  for (const product of products) {
    await insertProduct(product);
  }

  console.log("✅ Tutti i prodotti sono stati caricati su Qdrant!");
}

syncProductsWithQdrant().catch(err => console.error("Errore generale:", err));
