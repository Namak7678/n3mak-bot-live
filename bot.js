// N3mak Telegram bot — Telegram Stars subscriptions (zero external payment provider)
// Webhook mode for Render free tier. No dependencies beyond Node 20 built-ins.
const http = require("http");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE44_TOKEN = process.env.BASE44_SERVICE_TOKEN || "";
const BASE44_SALES = "https://base44.app/api/apps/6ab5921b9ca1863c59719606/entities/Sale";
const API = `https://api.telegram.org/bot${TOKEN}`;

const PLANS = {
  basic: { title: "نعمك أساسي — شهري", desc: "إشارات نعمك اليومية + تنبيهات الفرص", stars: 300 },
  pro: { title: "نعمك برو — شهري", desc: "كل مزايا الأساسي + تحليل محفظة + أولوية دعم", stars: 900 },
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
      [{ text: "باقة أساسي — 300 ⭐", callback_data: "plan_basic" }],
      [{ text: "باقة برو — 900 ⭐", callback_data: "plan_pro" }],
      [{ text: "المساعدة", callback_data: "help" }],
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

async function handleUpdate(u) {
  if (u.pre_checkout_query) {
    await tg("answerPreCheckoutQuery", { pre_checkout_query_id: u.pre_checkout_query.id, ok: true });
    return;
  }
  const msg = u.message;
  if (!msg) return;

  if (msg.successful_payment) {
    const p = msg.successful_payment;
    const planName = (p.invoice_payload || "").replace("plan_", "") || "basic";
    await recordSale(planName, p.total_amount, p.telegram_payment_charge_id, msg.from.id, msg.from.username);
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `تم تفعيل اشتراكك ✅\n\nالباقة: ${PLANS[planName] ? PLANS[planName].title : planName}\nالمدفوع: ${p.total_amount} نجمة\n\nتقدر تلغي أي وقت بـ /stop`,
    });
    return;
  }

  if (msg.callback_query) {
    const cb = msg.callback_query;
    const data = cb.data || "";
    if (data === "help") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id });
      await tg("sendMessage", { chat_id: cb.message.chat.id, text: "اكتب /start لعرض الباقات. الدفع بالنجوم داخل تليجرام بدون بطاقة." });
      return;
    }
    if (data.startsWith("plan_")) {
      const key = data.slice(5);
      const plan = PLANS[key];
      await tg("answerCallbackQuery", { callback_query_id: cb.id });
      if (!plan) return;
      await tg("sendInvoice", {
        chat_id: cb.message.chat.id,
        title: plan.title,
        description: plan.desc,
        payload: `plan_${key}`,
        currency: "XTR",
        prices: [{ label: plan.title, amount: plan.stars }],
      });
    }
    return;
  }

  if (msg.text === "/start") {
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: "أهلاً بك في *نعمك AI* 🌳\n\nاختر باقتك — الدفع بنجوم تليجرام، بدون بطاقة وبدون تسجيل.",
      parse_mode: "Markdown",
      reply_markup: mainKeyboard(),
    });
    return;
  }

  if (msg.text === "/help") {
    await tg("sendMessage", { chat_id: msg.chat.id, text: "الأوامر: /start الباقات — /stop إلغاء الاشتراك — /id رقم حسابك" });
    return;
  }

  if (msg.text === "/id") {
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
        const update = JSON.parse(body || "{}");
        await handleUpdate(update);
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
