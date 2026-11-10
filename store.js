// Durable store on Neon Postgres. Render's free tier wipes the local disk on every
// restart, so channel/order state must live in the database instead of a file.
const { Pool } = require("pg");

let pool = null;
let ready = false;

function init() {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3 });
  pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      chat_id TEXT PRIMARY KEY,
      title TEXT,
      active BOOLEAN DEFAULT TRUE,
      added TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      chat_id TEXT,
      title TEXT,
      amount NUMERIC,
      currency TEXT DEFAULT 'USDT',
      status TEXT DEFAULT 'pending',
      created TIMESTAMPTZ DEFAULT NOW()
    );
  `).then(() => { ready = true; console.log("store ready"); })
    .catch((e) => console.error("store init failed:", e.message));
}

async function upsertChannel(chatId, title) {
  if (!ready) return false;
  try {
    await pool.query(
      `INSERT INTO channels (chat_id, title) VALUES ($1,$2)
       ON CONFLICT (chat_id) DO UPDATE SET title = EXCLUDED.title, last_seen = NOW(), active = TRUE`,
      [String(chatId), title || ""],
    );
    return true;
  } catch (e) { console.error("upsertChannel:", e.message); return false; }
}

async function listChannels() {
  if (!ready) return [];
  try {
    const r = await pool.query("SELECT chat_id, title, active FROM channels WHERE active ORDER BY last_seen DESC LIMIT 50");
    return r.rows;
  } catch (e) { return []; }
}

async function addOrder(chatId, title, amount, currency) {
  if (!ready) return null;
  try {
    const r = await pool.query(
      "INSERT INTO orders (chat_id, title, amount, currency) VALUES ($1,$2,$3,$4) RETURNING id",
      [String(chatId), title, amount, currency || "USDT"]);
    return r.rows[0].id;
  } catch (e) { console.error("addOrder:", e.message); return null; }
}

async function recentOrders() {
  if (!ready) return [];
  try {
    const r = await pool.query("SELECT id, title, amount, status, created FROM orders ORDER BY id DESC LIMIT 10");
    return r.rows;
  } catch (e) { return []; }
}

function isReady() { return ready; }

module.exports = { init, upsertChannel, listChannels, addOrder, recentOrders, isReady };
