const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
app.use(express.json());

const SHOPIFY_API_URL = process.env.SHOPIFY_API_URL;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION_NAME = "products";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SHOPIFY_API_URL || !SHOPIFY_ADMIN_TOKEN || !OPENAI_API_KEY) {
  throw new Error(
    "Errore: variabili d'ambiente non definite (SHOPIFY_API_URL, SHOPIFY_ADMIN_TOKEN, OPENAI_API_KEY)"
  );
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ------------------- FUNZIONI -------------------

async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return response.data[0].embedding;
}

async function fetchShopify(query) {
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
    console.error("Errori GraphQL:", response.data.errors);
    throw new Error("Errore dalla Shopify GraphQL API");
  }
  return response.data.data.products;
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
    products = products.concat(data.edges.map((edge) => edge.node));
    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
  }
  return products;
}

async function getAllQdrantIds() {
  const response = await axios.post(
    `${QDRANT_URL}/collections/${COLLECTION_NAME}/points/scroll`,
    {
      limit: 10000,
      with_payload: false,
    }
  );
  return response.data.result.points.map((p) => p.id);
}

async function insertProduct(product) {
  const tagsAsString = Array.isArray(product.tags)
    ? product.tags.join(", ")
    : product.tags || "";
  const textToEmbed = `
    Title: ${product.title || ""}
    Description: ${product.description || ""}
    Vendor: ${product.vendor || ""}
    Product Type: ${product.productType || ""}
    Tags: ${tagsAsString}
  `;

  const vector = await generateEmbedding(textToEmbed);
  const qdrantId = parseInt(product.id.split("/").pop(), 10);

  const payload = {
    title: product.title,
    description: product.description,
    handle: product.handle,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    status: product.status,
  };

  await axios.put(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points`, {
    points: [{ id: qdrantId, vector: vector, payload: payload }],
  });
}

async function syncShopifyWithQdrant() {
  console.log("🔄 Avvio sincronizzazione Shopify → Qdrant...");

  const shopifyProducts = await getAllProducts();
  const shopifyIds = shopifyProducts.map((p) =>
    parseInt(p.id.split("/").pop(), 10)
  );

  const qdrantIds = await getAllQdrantIds();

  const productsToUpsert = shopifyProducts.filter(
    (p) => !qdrantIds.includes(parseInt(p.id.split("/").pop(), 10))
  );
  const productsToDelete = qdrantIds.filter((id) => !shopifyIds.includes(id));

  console.log(`➕ Da inserire/aggiornare: ${productsToUpsert.length}`);
  console.log(`❌ Da eliminare: ${productsToDelete.length}`);

  for (const product of productsToUpsert) {
    await insertProduct(product);
    console.log(`✔ Inserito/Aggiornato: ${product.title}`);
  }

  if (productsToDelete.length > 0) {
    await axios.post(
      `${QDRANT_URL}/collections/${COLLECTION_NAME}/points/delete`,
      {
        points: productsToDelete,
      }
    );
    console.log(`✖ Eliminati ${productsToDelete.length} prodotti da Qdrant.`);
  }

  console.log("✅ Sincronizzazione completata!");
  return {
    upserted: productsToUpsert.length,
    deleted: productsToDelete.length,
  };
}

// ------------------- ENDPOINT HTTP -------------------
app.post("/sync", async (req, res) => {
  try {
    const result = await syncShopifyWithQdrant();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error("Errore nella sync:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ------------------- AVVIO SERVER -------------------
const PORT = process.env.API_PORT || 3001;
app.listen(PORT, () => {
  console.log(`Sync API server avviato su http://shopify-service:${PORT}`);
});
