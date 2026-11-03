// N3mak Telegram bot — sells a digital product + subscriptions with Telegram Stars.
// Webhook mode for Render free tier. Node 20 built-ins only.
const http = require("http");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE44_TOKEN = process.env.BASE44_SERVICE_TOKEN || "";
const BASE44_SALES = "https://base44.app/api/apps/6ab5921b9ca1863c59719606/entities/Sale";
const API = `https://api.telegram.org/bot${TOKEN}`;

const PRODUCT_FILE = "https://base44.app/api/apps/6ab5921b9ca1863c59719606/files/mp/public/6ab5921b9ca1863c59719606/a414de526_AI-Automation-Blueprints.pdf";
const OR_KEY = process.env.OPENROUTER_API_KEY || "";
const OR_URL = "https://openrouter.ai/api/v1/chat/completions";
const OR_MODELS = ["nvidia/nemotron-3.5-super-vl:free", "dots-studio/dots-3-note-preview:free", "liquid/lfm-2.5-2.6b:free"];
const SYSTEM = "You are N3mak AI, a business assistant for small companies. Answer in the user's language, max 120 words, concrete and practical, no fluff. If asked about pricing for automation work: setup 1500 USD plus 200 monthly for a customer support assistant, 3000 plus 400 for systems integration. If unsure, say so plainly.";

async function aiReply(text) {
  for (const model of OR_MODELS) {
    try {
      const res = await fetch(OR_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${OR_KEY}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: text }],
          max_tokens: 500,
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
  pro: {
    title: "N3mak Pro — monthly",
    desc: "Everything in Basic + one custom automation built for you each month.",
    stars: 900,
    kind: "sub",
  },
};

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

async function handleUpdate(u) {
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
    await deliver(msg.chat.id, planKey);
    return;
  }

  const cb = msg.callback_query || u.callback_query;
  if (cb) {
    const data = cb.data || "";
    const chatId = cb.message ? cb.message.chat.id : cb.from.id;
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

  const text = msg.text || "";
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
    await tg("sendMessage", { chat_id: msg.chat.id, text: "لحظة…" }).catch(() => null);
    const answer = await aiReply(text);
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: answer || "المساعد مشغول الآن، جرّب بعد دقيقة.",
    });
    return;
  }

  if (text === "/help") {
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: "/start الباقات و الحزمة\n/pack شراء الحزمة مباشرة\n/id رقم حسابك",
    });
    return;
  }

  if (text === "/id") {
    await tg("sendMessage", { chat_id: msg.chat.id, text: `رقم حسابك: ${msg.from.id}` });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("n3mak bot ok");
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`n3mak bot listening on ${PORT}`));
