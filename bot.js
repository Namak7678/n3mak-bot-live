// N3mak Telegram bot — sells a digital product + subscriptions with Telegram Stars.
// Webhook mode for Render free tier. Node 20 built-ins only.
const http = require("http");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE44_TOKEN = process.env.BASE44_SERVICE_TOKEN || process.env.BASE44_TOKEN || process.env.BASE44_KEY || "";
const fs = require("fs");
const store = require("./store");
store.init();
const POST_EVERY_MS = 6 * 60 * 60 * 1000;
const SEED_POSTS = [
  "فحصنا اسم شركة في قوائم تسريب الفدية المنشورة. النتيجة لا تظهر في أي تقرير أمني عادي. اكتب /dive في @N3mak_bot",
  "موقعك يخبرني بأكثر مما تظن: التقنية، والقناة التي تفتقدها، وكم تكلفك. اكتب /blue في @N3mak_bot",
  "لا تقرأ تقريرا أمنيا يقول أنت آمن. اقرأ واحدا يقول: هذه مصادري، وهذا ما لا أغطيه، وهذه خطواتك الأربع.",
  "كل رسالة عميل بلا رد فوري هي عميل يشتري من غيرك. مساعد يرد في ثانية، من 900 دولار.",
];
const STORE_PATH = process.env.STORE_PATH || "./n3mak_store.json";
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, "utf8")); } catch { return { channels: [], orders: [] }; }
}
function saveStore(st) {
  try { fs.writeFileSync(STORE_PATH, JSON.stringify(st, null, 1)); } catch (e) { console.error("store save failed", e.message); }
}
let STORE = loadStore();
const BASE44_SALES = "https://base44.app/api/apps/6ab5921b9ca1863c59719606/entities/Sale";
const API = `https://api.telegram.org/bot${TOKEN}`;

const PRODUCT_FILE = "https://base44.app/api/apps/6ab5921b9ca1863c59719606/files/mp/public/6ab5921b9ca1863c59719606/a414de526_AI-Automation-Blueprints.pdf";
const OR_KEY = process.env.OPENROUTER_API_KEY || "";
const OR_URL = "https://openrouter.ai/api/v1/chat/completions";
const OR_MODELS = ["liquid/lfm-2.5-2.6b:free", "openrouter/free", "nvidia/nemotron-3.5-lightning:free"];
const PAY_ADDR = "0xE18e7F67Ad6429577af6c394eBE94717A87B3Fae";
const PAY_API = "https://base44.app/api/apps/6ab5921b9ca1863c59719606/entities/Payment";
const RPC = "https://bsc-dataseed.binance.org";
const USDC_BSC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";

async function b44(path, method, payload) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${BASE44_TOKEN}` },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return res.json().catch(() => null);
}

async function usdcBalance() {
  const hexAddr = PAY_ADDR.slice(2).padStart(64, "0");
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: USDC_BSC, data: "0x70a08231" + hexAddr }, "latest"],
    }),
  });
  const d = await res.json();
  if (!d.result) return null;
  return Number(BigInt(d.result)) / 1e18;
}

async function createOrder(chatId, product, baseAmount) {
  const bal = await usdcBalance();
  if (bal === null) return null;
  // unique cents so we can attribute the incoming transfer
  const cents = Math.floor(Math.random() * 89) + 10;
  const amount = Number((baseAmount + cents / 100).toFixed(2));
  const orderId = "NMK" + Date.now().toString(36).toUpperCase();
  await b44(PAY_API, "POST", {
    order_id: orderId, amount, baseline_balance: bal,
    chat_id: String(chatId), product, status: "pending", currency: "USDC",
  });
  return { orderId, amount, balance: bal };
}

let CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "";

async function resolveChannel() {
  if (CHANNEL_ID) return CHANNEL_ID;
  const rows = await b44("https://base44.app/api/apps/6ab5921b9ca1863c59719606/entities/Channel?limit=1&sort=-created_date", "GET");
  const list = Array.isArray(rows) ? rows : rows && rows.data ? rows.data : [];
  if (list.length) CHANNEL_ID = String(list[0].chat_id || "");
  return CHANNEL_ID;
}

async function rememberChannel(chat, silent) {
  if (!chat || !chat.id) return;
  CHANNEL_ID = String(chat.id);
  STORE.channels = Array.isArray(STORE.channels) ? STORE.channels : [];
  if (!STORE.channels.some((c) => String(c.chat_id) === CHANNEL_ID)) {
    STORE.channels.push({ chat_id: CHANNEL_ID, title: chat.title || "", active: true, added: new Date().toISOString() });
    saveStore(STORE);
  }
  await store.upsertChannel(CHANNEL_ID, chat.title || "").catch(() => null);
  const rows = await b44("https://base44.app/api/apps/6ab5921b9ca1863c59719606/entities/Channel?limit=5", "GET");
  const list = Array.isArray(rows) ? rows : rows && rows.data ? rows.data : [];
  const found = list.find((r) => String(r.chat_id) === CHANNEL_ID);
  const payload = { chat_id: CHANNEL_ID, title: chat.title || "", active: true };
  const wr = found
    ? await b44(`https://base44.app/api/apps/6ab5921b9ca1863c59719606/entities/Channel/${found.id}`, "PUT", payload)
    : await b44("https://base44.app/api/apps/6ab5921b9ca1863c59719606/entities/Channel", "POST", payload);
  if (!wr || (!wr.id && !wr.updated_date)) console.error("channel write rejected", JSON.stringify(wr).slice(0, 160));
  const ar = /[\u0600-\u06FF]/.test(chat.title || "");
  if (silent) return;
  await tg("sendMessage", {
    chat_id: CHANNEL_ID,
    text: ar
      ? "تم ربط هذه القناة ببوت نعمك ✅\nسننشر هنا: عطور ليالي، خدمات الأتمتة، والمنتجات الرقمية.\nالبوت: @N3mak_bot"
      : "Channel connected to N3mak AI ✅\nWe will post here: automation services, the Layali perfume store and digital products.\nBot: @N3mak_bot",
  }).catch((e) => console.error("greet fail", e.message));
}
const POSTS = [
  "رد متأخر بساعة = طلب ضائع.\nالمساعد الذكي يرد في ثانيتين، 24 ساعة، وبلا إجازات.\nاكتب /order لبدء التجهيز.",
  "مساعد خدمة عملاء جاهز في 3 أيام.\n1500 دولار إعداد + 200 شهري.\nنصف المبلغ قبل البدء والباقي بعد التسليم.",
  "ربط الأنظمة ولوحة تحكم: تقرير يومي يوصلك تلقائيا بدل ساعة يدوية كل صباح.\nالتفاصيل: https://namak7678.github.io/n3mak-services/",
  "حزمة 10 مخططات أتمتة جاهزة للبيع، كل مخطط فيها البرومبت والسعر.\n450 نجمة داخل البوت.",
  "محتاج ننشر لك 7 منشورات أسبوعيا بدون ما تكتب حرفا؟\n900 دولار إعداد + 150 شهري.",
];
const EN_POSTS = [
  "A reply that takes an hour is an order you lost.\nAn AI assistant answers in two seconds, 24/7.\nType /shop in @N3mak_bot to see the store.",
  "Customer support assistant: 1500 USD setup, 200 monthly, live in 3 working days.\nPayment in USDC, verified on chain automatically.",
  "We sell our perfume house Layali worldwide now. 6 fragrances, paid in USDC, shipped from Riyadh.\n/shop inside the bot.",
  "10 automation blueprints, each with the exact prompt and the price to charge.\n450 Stars inside the bot.",
  "Systems integration and dashboard: 3000 USD setup, 400 monthly, 10 working days.\nScope: https://namak7678.github.io/n3mak-services/",
];
let enIndex = 0;
let postIndex = 0;

function isArabicTitle(t) {
  return /[\u0600-\u06FF]/.test(t || "");
}

async function postToChannels() {
  const rows = await b44("https://base44.app/api/apps/6ab5921b9ca1863c59719606/entities/Channel?limit=20", "GET");
  const list = Array.isArray(rows) ? rows : rows && rows.data ? rows.data : [];
  const active = list.filter((r) => r.active !== false && r.chat_id);
  for (const ch of active) {
    const ar = isArabicTitle(ch.title);
    const text = ar ? POSTS[postIndex % POSTS.length] : EN_POSTS[enIndex % EN_POSTS.length];
    await tg("sendMessage", { chat_id: String(ch.chat_id), text }).catch((e) => console.error("post fail", ch.chat_id, e.message));
    await b44(`https://base44.app/api/apps/6ab5921b9ca1863c59719606/entities/Channel/${ch.id}`, "PUT", { last_post_at: new Date().toISOString() }).catch(() => null);
  }
  postIndex += 1;
  enIndex += 1;
  return active.length;
}

setInterval(() => { postToChannels().catch((e) => console.error("post loop", e.message)); }, 6 * 60 * 60 * 1000);

const SHOP = [
  { slug: "riyadh", ar: "ليالي الرياض", size: "50 مل", sar: 380 },
  { slug: "jeddah", ar: "بحر جدّة", size: "50 مل", sar: 360 },
  { slug: "oud", ar: "عود الليل", size: "50 مل", sar: 620 },
  { slug: "taif", ar: "ورد الطائف", size: "50 مل", sar: 420 },
  { slug: "bakhoor", ar: "بخور الدار", size: "علبة", sar: 280 },
  { slug: "discovery", ar: "مجموعة الاكتشاف", size: "طقم", sar: 290 },
];
const TIERS = {
  support: { name: "مساعد خدمة عملاء", usd: 1500, days: 3 },
  content: { name: "أتمتة المحتوى والنشر", usd: 900, days: 5 },
  integrate: { name: "ربط الأنظمة ولوحة تحكم", usd: 3000, days: 10 },
};
const SAR_PER_USD = 3.75;
const usd = (sar) => Math.round((sar / SAR_PER_USD) * 100) / 100;


// ---- Dark Web Diver + Blue Hole, inside the bot (no backend function needed) ----
async function leakFeed() {
  const urls = ["https://api.ransomware.live/v2/recentvictims", "https://api.ransomware.live/recentvictims"];
  const seen = new Set();
  const items = [];
  for (const u of urls) {
    try {
      const res = await fetch(u, { headers: { "user-agent": "N3makDiver/1.0" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.data || [];
      for (const x of list) {
        const key = String(x.victim || x.post_title || "").toLowerCase();
        if (key && !seen.has(key)) { seen.add(key); items.push(x); }
      }
      if (items.length) break;
    } catch (e) { /* try next feed */ }
  }
  return items;
}

const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function darkDive(target) {
  const feed = await leakFeed();
  if (!feed.length) return null;
  const t = norm(target);
  const hits = feed.filter((x) => {
    const v = norm(x.victim || x.post_title);
    return t.length > 3 && v && (v.includes(t) || t.includes(v));
  });
  return { feedSize: feed.length, hits: hits.slice(0, 5) };
}

const STACK_RX = {
  shopify: /cdn\.shopify|shopify\.com/, wordpress: /wp-content|wp-includes/, salla: /salla\./,
  zid: /zid\.store/, webflow: /webflow/, nextjs: /__NEXT_DATA__|_next\/static/,
  cloudflare: /cloudflare/, hubspot: /hs-scripts|hubspot/, ga4: /gtag\/js\?id=g-|googletagmanager/,
  meta: /connect\.facebook\.net|fbq\(/, intercom: /intercom/, whatsapp: /wa\.me|api\.whatsapp/,
  calendly: /calendly/, stripe: /js\.stripe/, moyasar: /moyasar/, tap: /tap\.pay/,
};
const GAP_RX = [
  ["لا قناة رد فوري", /intercom|tawk|crisp|livechat|tidio|wa\.me|whatsapp|zendesk/, 1500],
  ["لا أسئلة شائعة", /faq|frequently asked|help center|الأسئلة الشائعة/, 700],
  ["لا حجز ذاتي", /book now|booking|appointment|calendly|cal\.com|احجز/, 900],
  ["لا نموذج تواصل", /<form|contact us|get in touch|اتصل بنا|تواصل معنا/, 600],
  ["لا أسعار ظاهرة", /price|pricing|ر\.س|sar|aed|₽/, 700],
  ["لا تتبع تحويلات", /gtag\/js|googletagmanager|fbq\(|metrika/, 500],
];

async function blueHole(url) {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const res = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (compatible; N3makBlueHole/1.0)" }, signal: AbortSignal.timeout(18000) });
    if (!res.ok) return { error: `الموقع أرجع ${res.status}` };
    const html = (await res.text()).slice(0, 400000).toLowerCase();
    const stack = Object.entries(STACK_RX).filter(([, rx]) => rx.test(html)).map(([k]) => k);
    const gaps = GAP_RX.filter(([, rx]) => !rx.test(html)).map(([label, , usd]) => ({ label, usd }));
    const value = gaps.reduce((a, g) => a + g.usd, 0);
    return { url: u, stack, gaps, value, score: Math.max(0, 100 - gaps.length * 14) };
  } catch (e) {
    return { error: "تعذر الوصول للموقع" };
  }
}

async function checkPendingOrders() {
  const orders = await b44(`${PAY_API}?q=${encodeURIComponent(JSON.stringify({ status: "pending" }))}`, "GET");
  const list = Array.isArray(orders) ? orders : orders && orders.data ? orders.data : [];
  if (!list.length) return;
  const bal = await usdcBalance();
  if (bal === null) return;
  for (const o of list) {
    const expected = Number(o.baseline_balance || 0) + Number(o.amount || 0);
    if (bal + 0.005 >= expected) {
      await b44(`${PAY_API}/${o.id}`, "PUT", { status: "paid", paid_at: new Date().toISOString(), tx_ref: `balance ${bal}` });
      await tg("sendMessage", {
        chat_id: o.chat_id,
        text: `تم استلام الدفع ✅

الطلب: ${o.order_id}
المبلغ: ${o.amount} USDC
سنبدأ التنفيذ ونرسل لك خطة العمل اليوم.`,
      });
      await tg("sendMessage", {
        chat_id: o.chat_id,
        text: `دفعة وصلت: ${o.order_id} — ${o.amount} USDC (${o.product})`,
      }).catch(() => null);
    }
  }
}

setInterval(() => { checkPendingOrders().catch((e) => console.error("check orders", e.message)); }, 10 * 60 * 1000);

const SYSTEM = `You are N3mak AI, a business assistant for small companies. Answer in the user's language (Arabic, Russian or English). Max 120 words. Concrete, no fluff.

OFFERS (quote exactly, never invent others):
1. Customer support assistant: setup 1500 USD + 200 USD/month. Delivery 3 working days.
2. Systems integration + dashboard: setup 3000 USD + 400 USD/month. Delivery 10 working days.
3. Content and publishing automation: setup 900 USD + 150 USD/month. Delivery 5 working days.

PAYMENT (always answer with this, never say payment is unspecified):
USDC on BNB Smart Chain (BEP-20): ${PAY_ADDR}
Payment terms: 50% before start, 50% on delivery. Telegram Stars are accepted only for the digital blueprint pack. If a client asks for another method, say bank transfer details are issued on the invoice and ask for their country.

PROOF: we are a small AI automation team, we build with n8n and LLMs, and the digital pack in this bot is a real sample of the work.

If unsure about a technical detail, say so plainly instead of guessing. Never promise results we cannot deliver.`;

async function aiReply(text) {
  for (const model of OR_MODELS) {
    try {
      const res = await fetch(OR_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${OR_KEY}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: text }],
          max_tokens: 900,
        }),
      });
      const d = await res.json();
      const out = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (out && out.trim()) return out.trim();
    } catch (e) {
      console.error("ai error", model, e.message);
    }
  }
  return "";
}

const LAST = new Map();

const PLANS = {
  pack: {
    title: "10 AI Automation Blueprints (PDF)",
    desc: "Ten ready-to-sell automations with the exact prompts, stack, deploy time and price to charge. Instant delivery.",
    stars: 450,
    kind: "file",
  },
  basic: {
    title: "N3mak Basic — monthly",
    desc: "Daily opportunities digest + automation alerts.",
    stars: 300,
    kind: "sub",
  },
  dive_report: {
    title: "Dark Web Diver — full report",
    desc: "Full exposure report: every published leak match, the group, the date, the country, containment steps and sources.",
    stars: 2300,
    kind: "report",
  },
  blue_report: {
    title: "Blue Hole — full dossier",
    desc: "Full website dossier: detected stack, every gap with its fix and price, 30-day repair plan and readiness score.",
    stars: 3800,
    kind: "report",
  },
  bundle_report: {
    title: "Diver + Blue Hole bundle",
    desc: "Both reports for one company in a single delivery.",
    stars: 4900,
    kind: "report",
  },
  pro: {
    title: "N3mak Pro — monthly",
    desc: "Everything in Basic + one custom automation built for you each month.",
    stars: 900,
    kind: "sub",
  },
};

async function deliverReport(chatId, planKey) {
  const mem = LAST.get(chatId) || {};
  const parts = [];
  if (planKey !== "blue_report") {
    const target = mem.dive || "";
    const r = target ? await darkDive(target) : null;
    if (r) {
      const hits = r.hits.length
        ? r.hits.map((h, i) => `${i + 1}. ${h.victim || h.post_title} | ${h.group_name || h.group || "?"} | ${h.country || ""} | ${h.discovered || h.published || ""}`).join("\n")
        : "لا مطابقة منشورة.";
      parts.push(`*دايفر الدارك ويب — ${target}*\nعدد الحالات المفحوصة: ${r.feedSize}\nالمطابقات:\n${hits}\n\nخطوات الاحتواء:\n1. تغيير كلمات المرور وفرض التحقق الثنائي.\n2. مراجعة الحسابات ذات الصلاحية العالية.\n3. فحص نقاط الوصول الخارجية والـVPN.\n4. نسخة احتياطية غير متصلة.\n\nالمصدر: قوائم ضحايا الفدية المنشورة علنا. عدم الظهور لا يعني السلامة.`);
    } else {
      parts.push("تعذر جلب بيانات التسريب الآن، وسنعيد الفحص ونرسل التقرير.");
    }
  }
  if (planKey !== "dive_report") {
    const b = mem.blue;
    if (b && !b.error) {
      const gaps = b.gaps.map((g, i) => `${i + 1}. ${g.label} — ${g.usd ? g.usd + " دولار" : "على التسعير"}`).join("\n");
      parts.push(`*بلو هول — ${b.url}*\nالتقنيات: ${b.stack.join(", ") || "غير معروفة"}\nدرجة الجاهزية: ${b.score}/100\n\nالثغرات:\n${gaps}\n\nخطة 30 يوما:\nالأسبوع 1: أعلى ثغرة أثرا.\nالأسبوع 2: قناة الرد الفوري.\nالأسبوع 3: الأتمتة والقياس.\nالأسبوع 4: مراجعة الأرقام.`);
    } else {
      parts.push("لم أجد تحليلا محفوظا لهذه المحادثة. اكتب /blue موقعك أولا ثم اطلب الملف.");
    }
  }
  await tg("sendMessage", { chat_id: chatId, text: parts.join("\n\n———\n\n"), parse_mode: "Markdown" });
}

async function tg(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return res.json().catch(() => ({}));
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📘 الحزمة — 450 ⭐", callback_data: "plan_pack" }],
      [{ text: "باقة أساسي — 300 ⭐ شهريا", callback_data: "plan_basic" }],
      [{ text: "باقة برو — 900 ⭐ شهريا", callback_data: "plan_pro" }],
    ],
  };
}

async function recordSale(plan, stars, chargeId, userId, username) {
  if (!BASE44_TOKEN) return;
  try {
    await fetch(BASE44_SALES, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${BASE44_TOKEN}` },
      body: JSON.stringify({
        order_id: chargeId,
        amount: stars,
        currency: "XTR",
        store: "N3mak Bot",
        product: `${plan} | user:${userId}${username ? " @" + username : ""}`,
      }),
    });
  } catch (e) {
    console.error("sale record failed", e.message);
  }
}

async function deliver(chatId, planKey) {
  const plan = PLANS[planKey];
  if (plan && plan.kind === "file") {
    await tg("sendDocument", { chat_id: chatId, document: PRODUCT_FILE });
    await tg("sendMessage", {
      chat_id: chatId,
      text: "وصلتك الحزمة ✅\n\nابدأ بالصفحة 2: كيف تستخدمها. اختر مخططا واحدا يناسب عميلا تعرفه، وانسخ الـPrompt كما هو. أول عميل يدفع تأسيس + شهري.",
    });
    return;
  }
  await tg("sendMessage", {
    chat_id: chatId,
    text: `تم تفعيل اشتراكك ✅\n\nالباقة: ${plan ? plan.title : planKey}\nاكتب /start في أي وقت لعرض الباقات.`,
  });
}


// With privacy mode disabled the bot sees every group message. Answer only when it is
// addressed to us (command or @mention), otherwise stay silent so it never floods a group.
const BOT_USERNAME = (process.env.BOT_USERNAME || "N3mak_bot").toLowerCase();
const isGroupChat = (chat) => chat && (chat.type === "group" || chat.type === "supergroup" || chat.type === "channel");

async function handleUpdate(u) {
  if (u.channel_post && u.channel_post.chat) {
    await rememberChannel(u.channel_post.chat);
    return;
  }
  if (u.my_chat_member && u.my_chat_member.chat && u.my_chat_member.chat.type !== "private") {
    await rememberChannel(u.my_chat_member.chat);
    return;
  }
  if (u.pre_checkout_query) {
    await tg("answerPreCheckoutQuery", { pre_checkout_query_id: u.pre_checkout_query.id, ok: true });
    return;
  }
  const msg = u.message;
  if (!msg) return;

  if (msg.successful_payment) {
    const p = msg.successful_payment;
    const planKey = (p.invoice_payload || "").replace("plan_", "") || "basic";
    await recordSale(planKey, p.total_amount, p.telegram_payment_charge_id, msg.from.id, msg.from.username);
    if (planKey === "dive_report" || planKey === "blue_report" || planKey === "bundle_report") {
      await deliverReport(msg.chat.id, planKey);
      return;
    }
    await deliver(msg.chat.id, planKey);
    return;
  }

  const cb = msg.callback_query || u.callback_query;
  if (cb) {
    const data = cb.data || "";
    const chatId = cb.message ? cb.message.chat.id : cb.from.id;
    if (data.startsWith("quote_")) {
      const key = data.slice(6);
      const tier = TIERS[key];
      await tg("answerCallbackQuery", { callback_query_id: cb.id });
      if (!tier) return;
      const o = await createOrder(chatId, `${tier.name} — setup (${tier.days} days)`, tier.usd);
      if (!o) {
        await tg("sendMessage", { chat_id: chatId, text: "تعذر إنشاء الطلب الآن، حاول بعد دقيقة." });
        return;
      }
      await tg("sendMessage", {
        chat_id: chatId,
        text: `عرض سعر جاهز: ${o.orderId}\n\n${tier.name}\nالإعداد: ${tier.usd} دولار + 200 دولار شهريا صيانة\nالتسليم: ${tier.days} أيام عمل\n\nأرسل ${o.amount} USDC على شبكة BNB Smart Chain إلى:\n${PAY_ADDR}\n\n50% مقدما و50% عند التسليم. البوت يتحقق آليا من وصول المبلغ.`,
        reply_markup: { inline_keyboard: [[{ text: "رمز QR للعنوان", url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${PAY_ADDR}` }]] },
      });
      return;
    }

    if (data.startsWith("plan_")) {
      const key = data.slice(5);
      const plan = PLANS[key];
      await tg("answerCallbackQuery", { callback_query_id: cb.id });
      if (!plan) return;
      await tg("sendInvoice", {
        chat_id: chatId,
        title: plan.title,
        description: plan.desc,
        payload: `plan_${key}`,
        currency: "XTR",
        prices: [{ label: plan.title, amount: plan.stars }],
      });
    }
    return;
  }

  if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
    await rememberChannel(msg.forward_from_chat);
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `تم ربط القناة: ${msg.forward_from_chat.title || msg.forward_from_chat.id} ✅`,
    }).catch(() => null);
    return;
  }

  const text = msg.text || "";

  if (isGroupChat(msg.chat)) {
    // Register on ANY activity: Render wipes local disk on restart, so the group list
    // must rebuild itself from live traffic instead of a file or an external DB.
    await rememberChannel(msg.chat, !text.startsWith("/")).catch(() => null);
    if (!text.startsWith("/") && !text.toLowerCase().includes("@" + BOT_USERNAME)) return;
  }
  if ((text === "/start" || text === "/start@N3mak_bot") && msg.chat && (msg.chat.type === "group" || msg.chat.type === "supergroup")) {
    await rememberChannel(msg.chat);
  }

  if (text === "/start") {
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: "*نعمك AI* 🌳\n\nالحزمة الجاهزة: 10 مخططات أتمتة للبيع، بالأسعار والـPrompts وسجل التسليم.\nوالاشتراكات الشهرية لمن يريد تنفيذا شهريا.\n\nواكتب أي سؤال مباشرة، المساعد الذكي يرد عليك هنا مجانا.",
      parse_mode: "Markdown",
      reply_markup: mainKeyboard(),
    });
    return;
  }

  if (text === "/pack" || text === "/product") {
    const plan = PLANS.pack;
    await tg("sendInvoice", {
      chat_id: msg.chat.id,
      title: plan.title,
      description: plan.desc,
      payload: "plan_pack",
      currency: "XTR",
      prices: [{ label: plan.title, amount: plan.stars }],
    });
    return;
  }

  if (text && !text.startsWith("/")) {
    await tg("sendMessage", { chat_id: msg.chat.id, text: "…" }).catch(() => null);
    const answer = await aiReply(text);
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: answer || "المساعد مشغول الآن، جرّب بعد دقيقة.",
    });
    return;
  }

  if (text.startsWith("/dive")) {
    const target = text.replace("/dive", "").trim();
    if (!target) { await tg("sendMessage", { chat_id: msg.chat.id, text: "اكتب: /dive اسم-الشركة أو النطاق" }); return; }
    await tg("sendMessage", { chat_id: msg.chat.id, text: "أفحص قوائم التسريب الآن…" });
    const r = await darkDive(target);
    if (!r) { await tg("sendMessage", { chat_id: msg.chat.id, text: "قاعدة التسريب غير متاحة الآن، حاول بعد دقائق." }); return; }
    if (!r.hits.length) {
      LAST.set(msg.chat.id, { ...(LAST.get(msg.chat.id) || {}), dive: target });
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        text: `دايفر الدارك ويب\n\nالهدف: ${target}\nالنتيجة: لا مطابقة في ${r.feedSize} حالة تسريب منشورة.\n\nهذا لا يعني السلامة، بل أنه لم يُنشر شيء حتى الآن.`,
        reply_markup: { inline_keyboard: [
          [{ text: "التقرير الكامل — 2300 ⭐", callback_data: "plan_dive_report" }],
          [{ text: "الباقة مع بلو هول — 4900 ⭐", callback_data: "plan_bundle_report" }],
        ] },
      });
      return;
    }
    const lines = r.hits.map((h, i) => `${i + 1}. ${String(h.victim || h.post_title).slice(0, 60)} — ${h.group_name || h.group || "?"} — ${h.country || ""}`).join("\n");
    LAST.set(msg.chat.id, { ...(LAST.get(msg.chat.id) || {}), dive: target });
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `تحذير: الهدف ${target} ظهر في قوائم التسريب\n\n${lines}\n\nالتقرير الكامل يشمل خطوات الاحتواء والمصادر.`,
      reply_markup: { inline_keyboard: [[{ text: "التقرير الكامل — 2300 ⭐", callback_data: "plan_dive_report" }]] },
    });
    return;
  }

  if (text.startsWith("/blue") || text.startsWith("/audit")) {
    const u = text.replace("/blue", "").replace("/audit", "").trim();
    if (!u) { await tg("sendMessage", { chat_id: msg.chat.id, text: "اكتب: /blue موقعك.com" }); return; }
    await tg("sendMessage", { chat_id: msg.chat.id, text: "أحلل الموقع الآن…" });
    const r = await blueHole(u);
    if (r.error) { await tg("sendMessage", { chat_id: msg.chat.id, text: r.error }); return; }
    const gaps = r.gaps.length ? r.gaps.map((g, i) => `${i + 1}. ${g.label} — إصلاح ${g.usd || 0} دولار`).join("\n") : "لا ثغرات واضحة";
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `بلو هول\n\n${r.url}\nالتقنيات: ${r.stack.join(", ") || "غير معروفة"}\nدرجة الجاهزية: ${r.score}\n\nالثغرات:\n${gaps}\n\nقيمة الإصلاحات: ${r.value} دولار.`,
      reply_markup: { inline_keyboard: [
        [{ text: "الملف الكامل — 3800 ⭐", callback_data: "plan_blue_report" }],
        [{ text: "تنفيذ الإصلاحات — عرض سعر", callback_data: "quote_support" }],
      ] },
    });
    LAST.set(msg.chat.id, { ...(LAST.get(msg.chat.id) || {}), blue: r });
    return;
  }

  if (text === "/quote") {
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: "اختر الخدمة المطلوبة وسننشئ لك طلب دفع بالسعر المحدد، بدون مفاوضات:\n\n١. مساعد خدمة عملاء — 1500 دولار إعداد، تسليم 3 أيام\n٢. أتمتة المحتوى — 900 دولار، تسليم 5 أيام\n٣. ربط الأنظمة ولوحة تحكم — 3000 دولار، تسليم 10 أيام",
      reply_markup: {
        inline_keyboard: [
          [{ text: "مساعد خدمة عملاء — 1500$", callback_data: "quote_support" }],
          [{ text: "أتمتة المحتوى — 900$", callback_data: "quote_content" }],
          [{ text: "ربط الأنظمة — 3000$", callback_data: "quote_integrate" }],
        ],
      },
    });
    return;
  }

  if (text === "/shop" || text === "/store") {
    const lines = SHOP.map((p, i) => `${i + 1}. ${p.ar} — ${p.size} — ${p.sar} ر.س (${usd(p.sar)} USDC)`).join("\n");
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `*عطور ليالي* 🌙\n\n${lines}\n\nالشحن 25 ر.س، ومجانا فوق 450 ر.س.\nللشراء: /order riyadh\nأو اكتب رقم المنتج مع كلمة order.`,
      parse_mode: "Markdown",
    });
    return;
  }

  if (text.startsWith("/order")) {
    const arg = text.replace("/order", "").trim();
    let item = SHOP.find((p) => p.slug === arg);
    if (!item && /^[1-9]$/.test(arg)) item = SHOP[Number(arg) - 1];
    if (arg && !item) {
      await tg("sendMessage", { chat_id: msg.chat.id, text: "المنتج غير موجود. اكتب /shop لعرض القائمة." });
      return;
    }
    const product = item ? `${item.ar} ${item.size}` : "Customer support assistant — setup";
    const base = item ? usd(item.sar + 25) : 1500;
    const o = await createOrder(msg.chat.id, product, base);
    if (!o) {
      await tg("sendMessage", { chat_id: msg.chat.id, text: "تعذر إنشاء الطلب الآن، حاول بعد دقيقة." });
      return;
    }
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `طلبك جاهز: ${o.orderId}\nالمنتج: ${product}\n\nأرسل ${o.amount} USDC على شبكة BNB Smart Chain إلى:\n${PAY_ADDR}\n\nUSDC على BSC فقط. البوت يتحقق تلقائيا ويبلغك عند وصول المبلغ.`,
      reply_markup: { inline_keyboard: [[{ text: "رمز QR", url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${PAY_ADDR}` }]] },
    });
    return;
  }

  if (false) {
    const o = await createOrder(msg.chat.id, "Customer support assistant — setup", 1500);
    if (!o) {
      await tg("sendMessage", { chat_id: msg.chat.id, text: "تعذر إنشاء الطلب الآن، حاول بعد دقيقة." });
      return;
    }
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `طلبك جاهز: ${o.orderId}\n\nأرسل ${o.amount} USDC على شبكة BNB Smart Chain إلى:\n${PAY_ADDR}\n\nمهم: USDC على BSC فقط. البوت يتحقق تلقائيا ويبلغك عند وصول المبلغ.`,
      reply_markup: { inline_keyboard: [[{ text: "عرض رمز QR", url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${PAY_ADDR}` }]] },
    });
    return;
  }

  if (text === "/pay") {
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `*الدفع* 💳\n\nUSDC على شبكة BNB Smart Chain فقط:\n\`${PAY_ADDR}\`\n\nشروط: 50% قبل البدء و50% عند التسليم.\nنجوم تليجرام للحزمة الرقمية فقط.`,
      parse_mode: "Markdown",
    });
    return;
  }

  if (text === "/help") {
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: "/start الباقات و الحزمة\n/pack شراء الحزمة مباشرة\n/pay بيانات الدفع\n/shop قائمة العطور\n/order riyadh شراء عطر\n/quote عرض سعر فوري\n/dive فحص تسريب اسم\n/blue تحليل موقع\n/bind ربط المجموعة\n/post نشر منشور في القناة\n/id رقم حسابك",
    });
    return;
  }

  if (text === "/bind" || text === "/bind@N3mak_bot") {
    const chat = msg.chat || {};
    if (chat.type === "private") {
      await tg("sendMessage", { chat_id: msg.chat.id, text: "اكتب /bind داخل المجموعة أو القناة نفسها، لا في الخاص." });
      return;
    }
    await rememberChannel(chat);
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `تم ربط هذه المجموعة: ${chat.title || chat.id} ✅\nسننشر هنا تلقائيا كل 6 ساعات.`,
    }).catch(() => null);
    return;
  }

  if (text === "/post") {
    const existing = await b44("https://base44.app/api/apps/6ab5921b9ca1863c59719606/entities/Channel?limit=20", "GET");
    const list = Array.isArray(existing) ? existing : existing && existing.data ? existing.data : [];
    if (!list.length) {
      await tg("sendMessage", { chat_id: msg.chat.id, text: "القناة غير مربوطة بعد. أنشئ قناة تليجرام وأضف البوت كمشرف، ثم أرسل لي رقمها." });
      return;
    }
    const n = await postToChannels();
    await tg("sendMessage", { chat_id: msg.chat.id, text: `تم النشر في ${n} قناة.` });
    return;
  }

  if (text === "/id") {
    await tg("sendMessage", { chat_id: msg.chat.id, text: `رقم حسابك: ${msg.from.id}` });
  }
}


// Self-healing: make sure Telegram always has our webhook (it silently disappears
// when a deploy is slow, and then the bot stops receiving any message).
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://n3mak-bot-n7dx.onrender.com/webhook";

async function ensureWebhook() {
  try {
    const info = await fetch(`${API}/getWebhookInfo`).then((r) => r.json());
    const current = info && info.result && info.result.url;
    if (current === WEBHOOK_URL) return;
    await tg("setWebhook", {
      url: WEBHOOK_URL,
      allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query", "pre_checkout_query", "my_chat_member", "chat_member"],
    });
    console.log("webhook repaired:", WEBHOOK_URL);
  } catch (e) {
    console.error("webhook check failed", e.message);
  }
}

setInterval(() => { ensureWebhook(); }, 30 * 60 * 1000);
setTimeout(() => { ensureWebhook(); }, 8000);

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && !req.url.startsWith("/status")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("n3mak bot ok");
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/admin/clean")) {
    const key = new URL(req.url, "http://x").searchParams.get("key");
    if (key !== process.env.TELEGRAM_BOT_TOKEN) { res.writeHead(403).end("no"); return; }
    const removed = await store.cleanTestChannels();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ removed, left: (await store.listChannels()).length }));
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/status")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      durable: store.isReady(),
      autonomy: "broadcast every 6h from Neon queue",
      channels_db: await store.listChannels(),
      orders_db: await store.recentOrders(),
      channels: STORE.channels || [],
      orders: (STORE.orders || []).slice(-10),
      base44_token_present: Boolean(BASE44_TOKEN),
      uptime_s: Math.round(process.uptime()),
    }));
    return;
  }

  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      res.writeHead(200).end("ok");
      try {
        await handleUpdate(JSON.parse(body || "{}"));
      } catch (e) {
        console.error("update failed", e.message);
      }
    });
    return;
  }
  res.writeHead(404).end();
});

async function broadcastTick() {
  try {
    await store.seedPosts(SEED_POSTS);
    const chans = await store.listChannels();
    if (!chans.length) return;
    const post = await store.nextPost();
    if (!post) return;
    for (const c of chans) {
      await tg("sendMessage", { chat_id: c.chat_id, text: post.body }).catch(() => null);
    }
    console.log(`broadcast ${post.id} to ${chans.length} channels`);
  } catch (e) { console.error("broadcast:", e.message); }
}
setInterval(broadcastTick, POST_EVERY_MS);
setTimeout(broadcastTick, 90 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`n3mak bot listening on ${PORT}`));
