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

async function nextPost() {
  if (!ready) return null;
  try {
    const r = await pool.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        body TEXT NOT NULL,
        sent BOOLEAN DEFAULT FALSE,
        sent_at TIMESTAMPTZ,
        created TIMESTAMPTZ DEFAULT NOW()
      );
    `).then(() => pool.query("SELECT id, body FROM posts WHERE sent = FALSE ORDER BY id LIMIT 1"));
    if (!r.rows.length) return null;
    await pool.query("UPDATE posts SET sent = TRUE, sent_at = NOW() WHERE id = $1", [r.rows[0].id]);
    return r.rows[0];
  } catch (e) { console.error("nextPost:", e.message); return null; }
}

async function seedPosts(list) {
  if (!ready || !list.length) return 0;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY, body TEXT NOT NULL, sent BOOLEAN DEFAULT FALSE,
      sent_at TIMESTAMPTZ, created TIMESTAMPTZ DEFAULT NOW())`);
    const empty = await pool.query("SELECT COUNT(*)::int AS n FROM posts");
    if (empty.rows[0].n > 0) return 0;
    for (const body of list) await pool.query("INSERT INTO posts (body) VALUES ($1)", [body]);
    return list.length;
  } catch (e) { return 0; }
}

async function ensureVisits() {
  await pool.query(`CREATE TABLE IF NOT EXISTS visits (
    id SERIAL PRIMARY KEY, source TEXT, chat_id TEXT, created TIMESTAMPTZ DEFAULT NOW())`);
}

async function recordVisit(source, chatId) {
  if (!ready) return false;
  try {
    await ensureVisits();
    await pool.query("INSERT INTO visits (source, chat_id) VALUES ($1,$2)", [source || "direct", String(chatId)]);
    return true;
  } catch (e) { console.error("recordVisit:", e.message); return false; }
}

async function visitStats() {
  if (!ready) return [];
  try {
    await ensureVisits();
    const r = await pool.query("SELECT source, COUNT(*)::int AS n FROM visits GROUP BY source ORDER BY n DESC LIMIT 10");
    return r.rows || [];
  } catch (e) { console.error("visitStats:", e.message); return []; }
}

async function ensureSignals() {
  await pool.query(`CREATE TABLE IF NOT EXISTS signals (
    id SERIAL PRIMARY KEY, kind TEXT, title TEXT, detail TEXT,
    score INT DEFAULT 0, created TIMESTAMPTZ DEFAULT NOW(), UNIQUE(title))`);
}

async function addSignal(kind, title, detail, score) {
  if (!ready) return false;
  try {
    await ensureSignals();
    await pool.query(
      "INSERT INTO signals (kind, title, detail, score) VALUES ($1,$2,$3,$4) ON CONFLICT (title) DO NOTHING",
      [kind, title, detail, score || 0]);
    return true;
  } catch (e) { console.error("addSignal:", e.message); return false; }
}

async function recentSignals(limit) {
  if (!ready) return [];
  try {
    await ensureSignals();
    const r = await pool.query("SELECT kind, title, detail, score, created FROM signals ORDER BY id DESC LIMIT $1", [limit || 5]);
    return r.rows || [];
  } catch (e) { return []; }
}

async function countSignals() {
  if (!ready) return 0;
  try {
    await ensureSignals();
    const r = await pool.query("SELECT COUNT(*)::int AS n FROM signals");
    return r.rows[0].n;
  } catch (e) { return 0; }
}

async function ensureInvoices() {
  await pool.query(`CREATE TABLE IF NOT EXISTS invoices (
    code TEXT PRIMARY KEY,
    chat_id TEXT,
    product TEXT,
    amount NUMERIC NOT NULL,
    currency TEXT DEFAULT 'USDC',
    status TEXT DEFAULT 'pending',
    baseline NUMERIC,
    address TEXT,
    created TIMESTAMPTZ DEFAULT NOW(),
    paid_at TIMESTAMPTZ
  )`);
}

async function createInvoice(chatId, product, amount, baseline, address) {
  if (!ready) return null;
  try {
    await ensureInvoices();
    const code = "NMK" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 90 + 10);
    await pool.query(
      "INSERT INTO invoices (code, chat_id, product, amount, baseline, address) VALUES ($1,$2,$3,$4,$5,$6)",
      [code, String(chatId), product || "N3mak service", amount, baseline, address]);
    return { code, amount };
  } catch (e) { console.error("createInvoice:", e.message); return null; }
}

async function getInvoice(code) {
  if (!ready) return null;
  try {
    await ensureInvoices();
    const r = await pool.query(
      "SELECT code, product, amount, currency, status, address, created, paid_at FROM invoices WHERE code = $1", [code]);
    return r.rows[0] || null;
  } catch (e) { return null; }
}

async function pendingInvoices() {
  if (!ready) return [];
  try {
    await ensureInvoices();
    const r = await pool.query(
      "SELECT code, chat_id, amount, baseline, address FROM invoices WHERE status = 'pending' ORDER BY created LIMIT 40");
    return r.rows || [];
  } catch (e) { return []; }
}

async function markInvoicePaid(code) {
  if (!ready) return false;
  try {
    await pool.query("UPDATE invoices SET status='paid', paid_at=NOW() WHERE code=$1", [code]);
    return true;
  } catch (e) { return false; }
}

async function invoiceStats() {
  if (!ready) return { paid: 0, pending: 0, volume: 0 };
  try {
    await ensureInvoices();
    const r = await pool.query(`SELECT
      COUNT(*) FILTER (WHERE status='paid')::int AS paid,
      COUNT(*) FILTER (WHERE status='pending')::int AS pending,
      COALESCE(SUM(amount) FILTER (WHERE status='paid'),0)::float AS volume FROM invoices`);
    return r.rows[0];
  } catch (e) { return { paid: 0, pending: 0, volume: 0 }; }
}

async function ensureClients() {
  await pool.query(`CREATE TABLE IF NOT EXISTS clients (
    code TEXT PRIMARY KEY, name TEXT, chat_id TEXT, plan TEXT DEFAULT 'starter',
    status TEXT DEFAULT 'active', created TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS subscribers (
    chat_id TEXT PRIMARY KEY, plan TEXT, country TEXT, since TIMESTAMPTZ DEFAULT NOW())`);
}

async function createClient(name, chatId) {
  if (!ready) return null;
  try {
    await ensureClients();
    const code = "CL" + Date.now().toString(36).toUpperCase().slice(-6);
    await pool.query("INSERT INTO clients (code, name, chat_id) VALUES ($1,$2,$3)", [code, name, String(chatId)]);
    return { code, name };
  } catch (e) { console.error("createClient:", e.message); return null; }
}

async function getClient(code) {
  if (!ready) return null;
  try {
    await ensureClients();
    const c = await pool.query("SELECT code, name, plan, status, created FROM clients WHERE code=$1", [code]);
    if (!c.rows.length) return null;
    const cl = c.rows[0];
    const inv = await pool.query(
      "SELECT code, product, amount, status, created FROM invoices WHERE chat_id=(SELECT chat_id FROM clients WHERE code=$1) ORDER BY created DESC LIMIT 10", [code]);
    return { ...cl, invoices: inv.rows || [] };
  } catch (e) { return null; }
}

async function countClients() {
  if (!ready) return 0;
  try { await ensureClients(); return (await pool.query("SELECT COUNT(*)::int AS n FROM clients")).rows[0].n; } catch (e) { return 0; }
}

async function addSubscriber(chatId, plan, country) {
  if (!ready) return false;
  try {
    await ensureClients();
    await pool.query(`INSERT INTO subscribers (chat_id, plan, country) VALUES ($1,$2,$3)
      ON CONFLICT (chat_id) DO UPDATE SET plan=EXCLUDED.plan, country=EXCLUDED.country`, [String(chatId), plan, country || null]);
    return true;
  } catch (e) { return false; }
}

async function listSubscribers() {
  if (!ready) return [];
  try { await ensureClients(); return (await pool.query("SELECT chat_id, plan, country FROM subscribers")).rows || []; } catch (e) { return []; }
}

async function signalsByCountry(country, limit) {
  if (!ready) return [];
  try {
    await ensureSignals();
    if (!country) return (await pool.query("SELECT title, detail, score FROM signals ORDER BY id DESC LIMIT $1", [limit || 25])).rows;
    return (await pool.query("SELECT title, detail, score FROM signals WHERE detail ILIKE $1 ORDER BY id DESC LIMIT $2",
      ["%" + country + "%", limit || 25])).rows;
  } catch (e) { return []; }
}

async function exposureIndex() {
  if (!ready) return [];
  try {
    await ensureSignals();
    const r = await pool.query(`
      SELECT upper(substring(detail from 'country: ([A-Za-z]{2})')) AS country, COUNT(*)::int AS n
      FROM signals WHERE detail ~ 'country: [A-Za-z]{2}'
      GROUP BY 1 ORDER BY n DESC LIMIT 60`);
    const rows = r.rows.filter((x) => x.country);
    const max = rows.length ? Math.max(...rows.map((x) => x.n)) : 1;
    return rows.map((x) => ({
      country: x.country,
      victims: x.n,
      index: Math.min(100, Math.round((x.n / max) * 100)),
      level: x.n / max > 0.66 ? "critical" : x.n / max > 0.33 ? "elevated" : "watch",
    }));
  } catch (e) { console.error("exposureIndex:", e.message); return []; }
}

async function ensureWatch() {
  await pool.query(`CREATE TABLE IF NOT EXISTS watch (
    channel TEXT PRIMARY KEY, posts INT DEFAULT 0, last_at TIMESTAMPTZ)`);
}

async function touchWatch(channel, posts) {
  if (!ready) return;
  try {
    await ensureWatch();
    await pool.query(`INSERT INTO watch (channel, posts, last_at) VALUES ($1,$2,NOW())
      ON CONFLICT (channel) DO UPDATE SET posts = watch.posts + $2, last_at = NOW()`, [channel, posts]);
  } catch (e) { console.error("touchWatch:", e.message); }
}

async function watchStats() {
  if (!ready) return [];
  try { await ensureWatch(); return (await pool.query("SELECT channel, posts, last_at FROM watch ORDER BY posts DESC")).rows || []; }
  catch (e) { return []; }
}

async function signalsByKind(kind, limit) {
  if (!ready) return [];
  try {
    await ensureSignals();
    return (await pool.query("SELECT title, detail, score, created FROM signals WHERE kind=$1 ORDER BY id DESC LIMIT $2", [kind, limit || 10])).rows || [];
  } catch (e) { return []; }
}

async function cleanTestChannels() {
  if (!ready) return 0;
  try {
    const r = await pool.query("DELETE FROM channels WHERE title ILIKE '%test%' OR title ILIKE '%probe%' OR title ILIKE '%dbg%'");
    return r.rowCount;
  } catch (e) { return 0; }
}

function isReady() { return ready; }

module.exports = { init, upsertChannel, listChannels, addOrder, recentOrders, nextPost, seedPosts, cleanTestChannels, recordVisit, visitStats, addSignal, recentSignals, countSignals, createInvoice, getInvoice, pendingInvoices, markInvoicePaid, invoiceStats, createClient, getClient, countClients, addSubscriber, listSubscribers, signalsByCountry, exposureIndex, touchWatch, watchStats, signalsByKind, isReady };
