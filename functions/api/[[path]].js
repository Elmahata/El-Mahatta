/**
 * Cloudflare Pages Function — API تطبيق «المحطة» — توكتوك بسعر ثابت
 *
 * النموذج: سعر ثابت منشور + سباق قبول بين السائقين (أول من يقبل يأخذ المشوار).
 * لا مزايدة ولا مفاصلة — السعر يُحسب على الخادم دائماً ولا يُؤخذ من العميل أبداً.
 *
 * Bindings المطلوبة:
 *   DB        → قاعدة بيانات D1
 *   ADMIN_PIN → الرقم السرّي للإدارة (Secret)
 *
 * المسارات:
 *   GET    /api/public               عام — المناطق والنقاط والأسعار
 *   POST   /api/request              عام — إنشاء طلب → { id, token }
 *   GET    /api/track/:id?token=     عام — متابعة حالة الطلب (+ كود الركوب بعد القبول)
 *   GET    /api/share/:id?s=         عام — صفحة «شارك رحلتك» للأهل (بدون أرقام)
 *   POST   /api/report               عام — بلاغ من الراكب (مثلاً: طلب أكتر من السعر)
 *   POST   /api/driver/start         سائق — بدء الرحلة بكود الركوب
 *   POST   /api/phone-request        إدارة — طلب بالتليفون تدخّله الإدارة
 *   POST   /api/driver/login         سائق — رقم الموبايل + الكود
 *   GET    /api/driver/feed          سائق — الطلبات المتاحة + مشواره الحالي
 *   POST   /api/driver/claim         سائق — قبول طلب (ذرّي، أول من يصل)
 *   POST   /api/driver/finish        سائق — إنهاء أو ترك المشوار
 *   POST   /api/driver/online        سائق — أونلاين/أوفلاين
 *   POST   /api/login                إدارة — التحقق من الرقم السرّي
 *   GET    /api/state                إدارة — كل البيانات
 *   PUT    /api/doc/:kind/:id        إدارة — إضافة/تعديل
 *   DELETE /api/doc/:kind/:id        إدارة — حذف
 */

const KINDS = ["zones", "places", "drivers", "requests", "config", "reports"];
const PUBLIC_KINDS = ["zones", "places", "config"];
const MAX_BODY = 16 * 1024;
const ONLINE_MS = 90 * 1000;              // يُعتبر السائق أونلاين إن نبض خلال هذه المدة
const CLAIM_WINDOW_MS = 25 * 60 * 1000;   // الطلب الأقدم من ذلك لا يُعرض للقبول

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** مقارنة ثابتة الزمن حتى لا يُخمَّن السرّ بقياس وقت الرد */
function safeEqual(a, b) {
  const x = String(a ?? ""), y = String(b ?? "");
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

const str = (v, max) => String(v ?? "").trim().slice(0, max);
const digits = (v) => String(v ?? "").replace(/\D/g, "");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function newToken() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readDocs(env, kinds) {
  const marks = kinds.map(() => "?").join(",");
  const { results } = await env.DB
    .prepare(`SELECT kind, id, data FROM docs WHERE kind IN (${marks})`).bind(...kinds).all();
  const out = {};
  for (const k of kinds) out[k] = [];
  for (const row of results || []) {
    try {
      const doc = JSON.parse(row.data);
      doc.id = doc.id || row.id;
      (out[row.kind] ||= []).push(doc);
    } catch { /* صف تالف: نتجاهله بدل إسقاط الطلب كله */ }
  }
  for (const k of kinds) out[k].sort((a, b) => (a.order || 0) - (b.order || 0));
  return out;
}

async function getDoc(env, kind, id) {
  const row = await env.DB.prepare("SELECT data FROM docs WHERE kind=? AND id=?").bind(kind, id).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

async function putDoc(env, kind, id, data) {
  await env.DB.prepare(
    `INSERT INTO docs (kind,id,data,updated) VALUES (?,?,?,?)
     ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, updated=excluded.updated`
  ).bind(kind, id, JSON.stringify(data), Date.now()).run();
}

async function parseBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new Error("too_large");
  return JSON.parse(raw || "{}");
}

const isAdmin = (req, env) =>
  Boolean(env.ADMIN_PIN) && safeEqual(req.headers.get("x-pin"), env.ADMIN_PIN);

/** السائق يُعرَّف برقم موبايله + كود خاص به تضبطه الإدارة */
async function getDriver(req, env) {
  const phone = digits(req.headers.get("x-driver-phone"));
  const code = digits(req.headers.get("x-driver-code"));
  if (!phone || !code) return null;
  const { drivers } = await readDocs(env, ["drivers"]);
  const d = drivers.find((x) => digits(x.phone) === phone);
  if (!d || d.active === false || !d.code || !safeEqual(code, String(d.code))) return null;
  return d;
}

/* مجاني لحد paidFrom، وبعدها اشتراك (أسبوعي أو شهري) بتسجّله الإدارة لما السائق يدفع كاش.
   بعد ما الاشتراك يخلص فيه مهلة (grace) أيام، وبعدها الطلبات بتوقف. */
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
async function subCfg(env) {
  const p = (await getDoc(env, "config", "pricing")) || {};
  return {
    paidFrom: p.paidFrom || "", week: p.week != null ? p.week : 30, month: p.month != null ? p.month : 100,
    grace: p.grace != null ? p.grace : 3,
  };
}
/** حالة اشتراك السائق: free | ok | grace | stopped */
function subState(d, c) {
  /* التطبيق مجاني بالكامل دلوقتي — لو حبيت ترجّع الاشتراكات، امسح السطر الجاي */
  if (!c.enabled) return { state: "free", until: "" };
  const today = todayStr();
  if (!c.paidFrom || today < c.paidFrom) return { state: "free", until: c.paidFrom || "" };
  const paidTo = d.subUntil && d.subUntil >= addDays(c.paidFrom, -1) ? d.subUntil : addDays(c.paidFrom, -1);
  if (today <= paidTo) return { state: "ok", until: paidTo };
  const stopOn = addDays(paidTo, c.grace + 1);
  return today < stopOn ? { state: "grace", until: paidTo, stopOn } : { state: "stopped", until: paidTo };
}
const subActive = (d, c) => !c || subState(d, c).state !== "stopped";
const todayStr = () => new Date().toISOString().slice(0, 10);

/** أقرب نقطة معروفة تحدد المنطقة — لا حاجة لحدود مرسومة */
function resolveLeg(places, o) {
  const lat = Number(o.lat), lng = Number(o.lng);
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  let near = null, bd = Infinity;
  for (const p of places) {
    if (p.lat == null || p.lng == null) continue;
    const dLat = (p.lat - lat) * 111320;
    const dLng = (p.lng - lng) * 111320 * Math.cos((lat * Math.PI) / 180);
    const d = Math.sqrt(dLat * dLat + dLng * dLng);
    if (d < bd) { bd = d; near = p; }
  }
  return {
    lat: +lat.toFixed(6), lng: +lng.toFixed(6),
    label: str(o.label, 120) || (near ? "جنب " + near.name : "موقع على الخريطة"),
    zoneId: near ? near.zoneId || "" : "",
    nearId: near ? near.id : "", nearMetres: near ? Math.round(bd) : null,
  };
}

/** ما يراه السائق قبل القبول: بلا اسم الراكب ولا رقمه */
const teaser = (r) => ({
  id: r.id, from: r.from, to: r.to, fare: r.fare, sameZone: r.sameZone, createdAt: r.createdAt, source: r.source || "app",
  scheduledAt: r.scheduledAt || null, forOther: Boolean(r.forOther),
});

/* الطلب المحجوز لبعدين بيظهر للسواقين قبل معاده بـ ١٥ دقيقة */
const LEAD_MS = 15 * 60 * 1000;
const openAt = (r) => (r.scheduledAt ? r.scheduledAt - LEAD_MS : r.createdAt || 0);
const PRIORITY_MS = 5000;   // سواقين المنطقة المفضّلة بيشوفوا الطلب قبل الباقي بـ ٥ ثواني
const REF_OFF = 5;          // خصم الدعوة
const refCode = (phone) => "M" + digits(phone).slice(-6);

const rideCode = () => String(1000 + (crypto.getRandomValues(new Uint16Array(1))[0] % 9000));
const tokOk = (given, real) => Boolean(real) && safeEqual(given, real);

/** إنشاء طلب — مشترك بين تطبيق الراكب وطلبات التليفون من الإدارة */

/* ===== تأكيد الرقم بكود على واتساب (WhatsApp Cloud API — رسالة Authentication) =====
   المتغيرات: WA_TOKEN + WA_PHONE_ID (+ WA_TEMPLATE اختياري، افتراضي mahatta_otp).
   لو مش موجودين ← التأكيد بيعدّي لوحده (التطبيق مايبوظش). */
const OTP_TTL = 10 * 60 * 1000, OTP_WAIT = 60 * 1000, OTP_DAY_MAX = 5, OTP_TRIES = 5;
const SESSION_TTL = 180 * 864e5;
const otpOn = (env) => Boolean(env.WA_TOKEN && env.WA_PHONE_ID);
const l10 = (p) => digits(p).slice(-10);
const intl = (p) => { const d = digits(p); return d.startsWith("20") ? d : d.startsWith("0") ? "20" + d.slice(1) : "20" + d; };
const rnd = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => (b % 10)).join("");
const tok = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");

async function newSession(env, phone, role) {
  const t = tok();
  await putDoc(env, "sessions", t, { phone: l10(phone), role, at: Date.now() });
  return t;
}
/** لو التأكيد شغال: لازم جلسة صحيحة لنفس الرقم. بيرجّع null لو تمام، أو رد خطأ */
async function needSession(request, env, phone, role) {
  if (!otpOn(env)) return null;
  const t = str(request.headers.get("x-session"), 80);
  const s = t ? await getDoc(env, "sessions", t) : null;
  if (!s || s.role !== role || s.phone !== l10(phone) || Date.now() - s.at > SESSION_TTL)
    return json({ error: "أكّد رقمك الأول — دوس تاني", reverify: role }, 401);
  return null;
}
async function sendOtp(env, phone, code) {
  const r = await fetch("https://graph.facebook.com/v21.0/" + env.WA_PHONE_ID + "/messages", {
    method: "POST",
    headers: { authorization: "Bearer " + env.WA_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: intl(phone), type: "template",
      template: {
        name: env.WA_TEMPLATE || "mahatta_otp", language: { code: env.WA_LANG || "ar" },
        components: [
          { type: "body", parameters: [{ type: "text", text: code }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
        ],
      },
    }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j.error && j.error.message) || "wa " + r.status); }
}

async function createRequest(env, b, source) {
  const name = str(b.riderName, 60);
  const phone = digits(b.riderPhone).slice(0, 15);
  if (!name || phone.length < 9) return { error: "الاسم ورقم الموبايل مطلوبان", status: 400 };

  const { places, config } = await readDocs(env, PUBLIC_KINDS);
  const cfg = config.find((c) => c.id === "pricing") || { same: 15, cross: 20 };

  const pick = (idKey, objKey) => {
    const pid = str(b[idKey], 40);
    if (pid) {
      const p = places.find((x) => x.id === pid);
      return p ? { lat: p.lat, lng: p.lng, label: p.name, zoneId: p.zoneId || "", nearId: p.id, nearMetres: 0 } : null;
    }
    return b[objKey] && typeof b[objKey] === "object" ? resolveLeg(places, b[objKey]) : null;
  };
  const from = pick("fromId", "from");
  const to = pick("toId", "to");
  if (!from || !to) return { error: "حدّد مكان الركوب والوجهة", status: 400 };

  /* السعر يُحسب هنا فقط — لا يُقرأ من العميل */
  const same = Boolean(from.zoneId && to.zoneId && from.zoneId === to.zoneId);
  let fare = same ? cfg.same : cfg.cross;
  const now = Date.now();

  /* احجز لبعدين: من ٢٠ دقيقة لحد ٧ أيام */
  let scheduledAt = null;
  if (b.scheduledAt) {
    const t = Number(b.scheduledAt);
    if (!isFinite(t) || t < now + 20 * 60000 || t > now + 7 * 864e5) return { error: "المعاد لازم يكون بعد ٢٠ دقيقة على الأقل وخلال أسبوع", status: 400 };
    scheduledAt = Math.round(t);
  }

  /* ادعي صاحبك: خصم ٥ ج لأول رحلة للمدعو، و٥ ج للي دعاه في رحلته الجاية. الإدارة بتعوّض السائق. */
  let refBy = "", refDiscount = 0;
  if (source === "app") {
    const { requests } = await readDocs(env, ["requests"]);
    const mine = requests.filter((r) => r.riderPhone === phone);
    const ref = str(b.ref, 12).toUpperCase();
    if (ref && ref !== refCode(phone) && !mine.length) {
      const inviter = requests.find((r) => refCode(r.riderPhone) === ref);
      if (inviter) { refBy = inviter.riderPhone; refDiscount = REF_OFF; }
    }
    if (!refDiscount) {
      const earned = requests.filter((r) => r.refBy === phone && r.status === "done").length;
      const used = mine.filter((r) => r.refCredit && r.status !== "cancelled").length;
      if (earned > used) refDiscount = REF_OFF;
    }
  }
  const discount = Math.min(refDiscount, fare - 5 > 0 ? refDiscount : 0);
  fare -= discount;

  const id = uid(), tok = newToken(), share = newToken().slice(0, 12);
  await putDoc(env, "requests", id, {
    id, token: tok, shareToken: share, code: rideCode(), source,
    riderName: name, riderPhone: phone, note: str(b.note, 140), from, to,
    fare, sameZone: same, status: "pending", driverId: "",
    createdAt: now, day: todayStr(), scheduledAt,
    forOther: Boolean(b.forOther), bookerPhone: b.forOther ? digits(b.bookerPhone).slice(0, 15) : "",
    discount, refBy: discount && refBy ? refBy : "", refCredit: Boolean(discount && !refBy),
  });
  return { ok: true, id, token: tok, shareToken: share, fare, sameZone: same, discount, scheduledAt, refCode: refCode(phone) };
}

export async function onRequest({ request, env, params }) {
  const parts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const [route, sub, third] = parts;
  const method = request.method;
  const url = new URL(request.url);
  if (!env.DB) return json({ error: "قاعدة البيانات غير مربوطة (binding: DB)" }, 500);

  try {
    /* ================= عام ================= */

    if (route === "public" && method === "GET") return json(await readDocs(env, PUBLIC_KINDS));

    if (route === "otp" && sub === "start" && method === "POST") {
      const b = await parseBody(request);
      const phone = digits(b.phone), role = "rider";
      if (phone.length < 10) return json({ error: "رقم الموبايل مش صحيح" }, 400);
      if (!otpOn(env)) return json({ skip: true, token: await newSession(env, phone, role) });
      const now = Date.now(), key = l10(phone);
      const log = (await getDoc(env, "otplog", key)) || { sends: [] };
      log.sends = log.sends.filter((t) => now - t < 864e5);
      const lastAt = log.sends[log.sends.length - 1] || 0;
      if (now - lastAt < OTP_WAIT) return json({ error: "استنى دقيقة وجرّب تاني" }, 429);
      if (log.sends.length >= OTP_DAY_MAX) return json({ error: "وصلت لآخر عدد أكواد النهارده — جرّب بكرة أو كلّم الإدارة" }, 429);
      const code = rnd(6), id = tok().slice(0, 20);
      try { await sendOtp(env, phone, code); }
      catch (e) { return json({ error: "ماقدرناش نبعت الكود — اتأكد إن الرقم عليه واتساب", detail: String(e.message).slice(0, 200) }, 502); }
      log.sends.push(now);
      await putDoc(env, "otplog", key, log);
      await putDoc(env, "otp", id, { phone: key, role, code, at: now, tries: 0 });
      return json({ id, wait: OTP_WAIT / 1000 });
    }

    if (route === "otp" && sub === "verify" && method === "POST") {
      const b = await parseBody(request);
      const id = str(b.id, 40), o = id ? await getDoc(env, "otp", id) : null;
      if (!o || o.used || Date.now() - o.at > OTP_TTL) return json({ error: "الكود خلص — دوس «ابعت تاني»" }, 400);
      if (o.tries >= OTP_TRIES) return json({ error: "جرّبت كتير — دوس «ابعت تاني»" }, 429);
      if (!safeEqual(digits(b.code), o.code)) {
        o.tries++; await putDoc(env, "otp", id, o);
        return json({ error: "الكود غلط — فاضللك " + (OTP_TRIES - o.tries) + " محاولات" }, 400);
      }
      o.used = true; await putDoc(env, "otp", id, o);
      return json({ token: await newSession(env, o.phone, o.role) });
    }

    if (route === "request" && method === "POST") {
      const b = await parseBody(request);
      const deny = await needSession(request, env, b.forOther && b.bookerPhone ? b.bookerPhone : b.riderPhone, "rider");
      if (deny) return deny;
      const out = await createRequest(env, b, "app");
      return out.error ? json({ error: out.error }, out.status) : json(out);
    }

    /* متابعة الراكب — بيانات السائق تظهر فقط بعد ما يَقبل */
    if (route === "track" && sub && method === "GET") {
      const r = await getDoc(env, "requests", str(sub, 40));
      if (!r) return json({ error: "طلب غير موجود" }, 404);
      if (!r.token || !safeEqual(url.searchParams.get("token"), r.token))
        return json({ error: "غير مصرّح" }, 401);
      let driver = null, driverLoc = null;
      if (r.driverId && r.status === "assigned") {
        const d = await getDoc(env, "drivers", r.driverId);
        if (d) {
          driver = { name: d.name, phone: d.phone, plate: d.plate, photo: d.photo || "" };
          if (d.loc && Date.now() - d.loc.at < 2 * 60 * 1000) driverLoc = d.loc;
        }
      }
      const pt = (p) => (p && p.lat != null ? { lat: p.lat, lng: p.lng, label: p.label } : null);
      return json({
        id: r.id, status: r.status, fare: r.fare, driver, driverLoc, from: pt(r.from), to: pt(r.to), createdAt: r.createdAt, scheduledAt: r.scheduledAt || null, discount: r.discount || 0,
        code: r.status === "assigned" ? r.code : null, startedAt: r.startedAt || null,
        shareToken: r.shareToken || null, reported: Boolean(r.reported),
      });
    }

    /* «شارك رحلتك»: الأهل يشوفوا الحالة واسم السائق ولوحته — من غير أي أرقام تليفونات */
    if (route === "share" && sub && method === "GET") {
      const r = await getDoc(env, "requests", str(sub, 40));
      if (!r || !tokOk(url.searchParams.get("s"), r.shareToken)) return json({ error: "اللينك ده مش صحيح" }, 404);
      let driver = null;
      if (r.driverId) {
        const d = await getDoc(env, "drivers", r.driverId);
        if (d) driver = { name: d.name, plate: d.plate, photo: d.photo || "" };
      }
      const first = (r.riderName || "").trim().split(/\s+/)[0] || "";
      return json({
        status: r.status, rider: first,
        from: { label: r.from.label, lat: r.from.lat, lng: r.from.lng },
        to: { label: r.to.label, lat: r.to.lat, lng: r.to.lng }, driver,
        createdAt: r.createdAt, assignedAt: r.assignedAt || null, startedAt: r.startedAt || null, finishedAt: r.finishedAt || null,
      });
    }

    /* تقييم السائق بعد الرحلة — مرة واحدة لكل رحلة */
    if (route === "rate" && method === "POST") {
      const b = await parseBody(request);
      const r = await getDoc(env, "requests", str(b.id, 40));
      if (!r || !tokOk(b.token, r.token)) return json({ error: "غير مصرّح" }, 401);
      if (r.status !== "done" || !r.driverId) return json({ error: "التقييم بعد ما الرحلة تخلص" }, 409);
      if (r.rating) return json({ error: "قيّمت الرحلة دي قبل كده" }, 409);
      const stars = Math.max(1, Math.min(5, parseInt(b.stars, 10) || 0));
      await putDoc(env, "requests", r.id, { ...r, rating: stars, ratingNote: str(b.note, 200) });
      const d = await getDoc(env, "drivers", r.driverId);
      if (d) await putDoc(env, "drivers", d.id, { ...d, ratingSum: (d.ratingSum || 0) + stars, ratingCount: (d.ratingCount || 0) + 1 });
      return json({ ok: true });
    }

    /* الدعم والشكاوى — من غير رحلة محددة */
    if (route === "support" && method === "POST") {
      const b = await parseBody(request);
      const phone = digits(b.phone).slice(0, 15);
      const note = str(b.note, 600);
      if (phone.length < 9 || !note) return json({ error: "اكتب رقمك والمشكلة" }, 400);
      const kinds = ["overcharge", "late", "behaviour", "lost", "suggest", "other"];
      const rid = uid();
      await putDoc(env, "reports", rid, {
        id: rid, requestId: str(b.requestId, 40), driverId: "", riderName: str(b.name, 60), riderPhone: phone,
        kind: kinds.includes(b.kind) ? b.kind : "other", asked: 0, fare: 0, note, status: "open", createdAt: Date.now(), source: "support",
      });
      return json({ ok: true });
    }

    /* رصيد الدعوات للراكب */
    if (route === "referral" && method === "GET") {
      const phone = digits(url.searchParams.get("phone"));
      if (phone.length < 9) return json({ error: "رقم غير صحيح" }, 400);
      const { requests } = await readDocs(env, ["requests"]);
      const invited = requests.filter((r) => r.refBy === phone);
      const earned = invited.filter((r) => r.status === "done").length;
      const used = requests.filter((r) => r.riderPhone === phone && r.refCredit && r.status !== "cancelled").length;
      return json({ code: refCode(phone), joined: invited.length, credit: Math.max(0, earned - used) * REF_OFF, off: REF_OFF });
    }

    /* بلاغ من الراكب — بيوصل للإدارة في تبويب «البلاغات» */
    if (route === "report" && method === "POST") {
      const b = await parseBody(request);
      const r = await getDoc(env, "requests", str(b.id, 40));
      if (!r || !tokOk(b.token, r.token)) return json({ error: "غير مصرّح" }, 401);
      const kinds = ["overcharge", "late", "behaviour", "lost", "other"];
      const kind = kinds.includes(b.kind) ? b.kind : "other";
      const asked = Math.max(0, Math.min(1000, parseInt(b.asked, 10) || 0));
      const rid = uid();
      await putDoc(env, "reports", rid, {
        id: rid, requestId: r.id, driverId: r.driverId || "", riderName: r.riderName, riderPhone: r.riderPhone,
        kind, asked, fare: r.fare, note: str(b.note, 400), status: "open", createdAt: Date.now(),
      });
      await putDoc(env, "requests", r.id, { ...r, reported: true });
      return json({ ok: true });
    }

    /* ================= رسايل + مكالمات بالنت بين الراكب والسائق =================
       رقم الراكب مابيظهرش للسائق. الرسايل مفتوحة والمشوار شغال، ونص ساعة بعد ما يخلص (لو حد نسي حاجة).
       المكالمة WebRTC (صوت بس)، والسيرفر بينقل رسايل الإعداد بس (offer/answer/bye). */
    if (route === "ice" && method === "GET") {
      const stun = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
      if (env.TURN_KEY_ID && env.TURN_KEY_TOKEN) {
        try {
          const r = await fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" + env.TURN_KEY_ID + "/credentials/generate", {
            method: "POST", headers: { authorization: "Bearer " + env.TURN_KEY_TOKEN, "content-type": "application/json" },
            body: JSON.stringify({ ttl: 3600 }),
          });
          const j = await r.json();
          if (j.iceServers) return json({ iceServers: stun.concat(Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers]) });
        } catch (e) {}
      }
      return json({ iceServers: stun });
    }

    if (route === "chat" && sub) {
      const r = await getDoc(env, "requests", str(sub, 40));
      if (!r) return json({ error: "طلب غير موجود" }, 404);
      let who = "";
      if (r.token && safeEqual(url.searchParams.get("token"), r.token)) who = "r";
      else { const me = await getDriver(request, env); if (me && me.id === r.driverId) who = "d"; }
      if (!who) return json({ error: "غير مصرّح" }, 401);
      const open = r.driverId && (r.status === "assigned" || (r.status === "done" && Date.now() - (r.finishedAt || 0) < 30 * 60 * 1000));
      const c = (await getDoc(env, "chat", r.id)) || { m: [], s: [] };
      if (method === "GET") {
        const after = +url.searchParams.get("after") || 0;
        let peer = "";
        if (who === "r" && r.driverId) { const d = await getDoc(env, "drivers", r.driverId); peer = d ? d.name : ""; }
        else peer = (r.riderName || "").trim().split(/\s+/)[0] || "الراكب";
        return json({
          me: who, peer, open: Boolean(open), status: r.status, now: Date.now(),
          m: c.m.filter((x) => x.at > after),
          s: c.s.filter((x) => x.at > after && x.f !== who),
        });
      }
      if (method === "POST") {
        if (!open) return json({ error: "الرسايل اتقفلت — المشوار خلص" }, 403);
        const b = await parseBody(request), now = Date.now();
        if (b.sig && typeof b.sig === "object") {
          const t = str(b.sig.type, 12);
          if (!["offer", "answer", "bye", "decline"].includes(t)) return json({ error: "نوع غير معروف" }, 400);
          c.s = c.s.filter((x) => now - x.at < 5 * 60 * 1000).concat([{ i: uid(), f: who, type: t, call: str(b.sig.call, 20), sdp: str(b.sig.sdp, 12000), at: now }]).slice(-20);
          if (t === "offer") c.m = c.m.concat([{ i: uid(), f: who, sys: "call", t: "", at: now }]).slice(-200);
        } else {
          const t = str(b.text, 500);
          if (!t) return json({ error: "الرسالة فاضية" }, 400);
          c.m = c.m.concat([{ i: uid(), f: who, t, at: now }]).slice(-200);
        }
        await putDoc(env, "chat", r.id, c);
        return json({ ok: true, at: now });
      }
    }

    /* ================= السائق ================= */

    if (route === "driver") {
      if (sub === "login" && method === "POST") {
        const b = await parseBody(request);
        const phone = digits(b.phone), code = digits(b.code);
        const { drivers } = await readDocs(env, ["drivers"]);
        const d = drivers.find((x) => digits(x.phone) === phone);
        if (!d || !d.code || !safeEqual(code, String(d.code)))
          return json({ error: "الرقم أو الكود غير صحيح" }, 401);
        if (d.active === false) return json({ error: "حسابك موقوف — كلّم الإدارة" }, 403);
        if (!subActive(d, await subCfg(env))) return json({ error: "اشتراكك منتهٍ — جدّده مع الإدارة علشان تستقبل مشاوير" }, 403);
        return json({ ok: true, driver: { id: d.id, name: d.name, plate: d.plate } });
      }

      const me = await getDriver(request, env);
      if (!me) return json({ error: "غير مصرّح" }, 401);
      const sc = await subCfg(env);
      const ss = subState(me, sc);
      /* السائق اللي اشتراكه وقف يقدر يفتح الصفحة ويشوف الرسالة، بس مايقدرش ياخد مشاوير */
      if (ss.state === "stopped" && !(sub === "feed" && method === "GET")) return json({ error: "اشتراكك منتهٍ — جدّده مع الإدارة" }, 403);

      /* مكان السائق لايف — بيتبعت وهو في مشوار بس، والراكب بيشوفه من /api/track */
      if (sub === "loc" && method === "POST") {
        const b = await parseBody(request);
        const lat = +b.lat, lng = +b.lng;
        if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return json({ error: "مكان غير صحيح" }, 400);
        if (me.loc && Date.now() - me.loc.at < 4000) return json({ ok: true });
        me.loc = { lat: +lat.toFixed(6), lng: +lng.toFixed(6), h: b.h != null && isFinite(+b.h) ? Math.round(+b.h) : null, at: Date.now() };
        await putDoc(env, "drivers", me.id, me);
        return json({ ok: true });
      }

      if (sub === "online" && method === "POST") {
        const b = await parseBody(request);
        me.online = b.online !== false;
        me.lastSeen = Date.now();
        await putDoc(env, "drivers", me.id, me);
        return json({ ok: true, online: me.online });
      }

      if (sub === "feed" && method === "GET") {
        me.lastSeen = Date.now();
        await putDoc(env, "drivers", me.id, me);
        const { requests } = await readDocs(env, ["requests"]);
        const now = Date.now();

        /* مشواره الحالي بالتفاصيل كاملة */
        const mineFull = requests
          .filter((r) => r.driverId === me.id && r.status === "assigned")
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
        /* الكود والتوكنات متبعتش للسائق — لازم يسأل الراكب */
        const mine = mineFull ? (({ code, token, shareToken, riderPhone, bookerPhone, refBy, ...rest }) => rest)(mineFull) : null;

        const blocked = ss.state === "stopped";
        const zones = Array.isArray(me.zones) ? me.zones : [];
        const heading = me.heading && me.heading.day === todayStr() && me.heading.active ? me.heading : null;

        /* السباق: كل الطلبات المفتوحة معروضة على كل سائق أونلاين بلا مرسال.
           سواق المنطقة المفضّلة بيشوف الطلب على طول، والباقي بعد ٥ ثواني. */
        const open = (me.online === false || mine || blocked) ? [] : requests
          .filter((r) => r.status === "pending" && now >= openAt(r) && now - openAt(r) < CLAIM_WINDOW_MS)
          .filter((r) => now - openAt(r) >= PRIORITY_MS || zones.includes(r.from && r.from.zoneId));
        const available = open
          .filter((r) => !heading || (r.to && r.to.zoneId === heading.zoneId))
          .sort((a, b) => openAt(b) - openAt(a))
          .slice(0, 20)
          .map(teaser);
        const hidden = open.length - available.length;

        const done = requests.filter((r) => r.driverId === me.id && r.status === "done" && r.day === todayStr());
        return json({
          me: { id: me.id, name: me.name, plate: me.plate, online: me.online !== false, zones, heading },
          sub: { ...ss, week: sc.week, month: sc.month, grace: sc.grace },
          available, mine, hidden,
          today: { rides: done.length, earned: done.reduce((s, r) => s + (r.fare || 0), 0) },
        });
      }

      /* أرباحي + اشتراكي + تقييمي */
      if (sub === "stats" && method === "GET") {
        const { requests } = await readDocs(env, ["requests"]);
        const days = [];
        for (let i = 6; i >= 0; i--) {
          const d = addDays(todayStr(), -i);
          const list = requests.filter((r) => r.driverId === me.id && r.status === "done" && r.day === d);
          days.push({
            day: d, rides: list.length,
            earned: list.reduce((s, r) => s + (r.fare || 0) + (r.discount || 0), 0),
            cross: list.filter((r) => !r.sameZone).length,
          });
        }
        return json({
          days, rating: me.ratingCount ? +(me.ratingSum / me.ratingCount).toFixed(1) : null, ratingCount: me.ratingCount || 0,
          sub: { ...ss, week: sc.week, month: sc.month, grace: sc.grace }, paidLog: (me.paidLog || []).slice(-6).reverse(),
          zones: Array.isArray(me.zones) ? me.zones : [], heading: me.heading || null,
        });
      }

      /* مناطقي المفضّلة (لحد ٣) + رايح ناحية (مرتين في اليوم) */
      if (sub === "prefs" && method === "POST") {
        const b = await parseBody(request);
        if (Array.isArray(b.zones)) me.zones = b.zones.map((z) => str(z, 20)).filter(Boolean).slice(0, 3);
        if (b.heading !== undefined) {
          const t = todayStr();
          const h = me.heading && me.heading.day === t ? me.heading : { day: t, uses: 0 };
          if (b.heading && b.heading.zoneId) {
            if ((h.uses || 0) >= 2 && !(h.active && h.zoneId === b.heading.zoneId)) return json({ error: "استخدمت «رايح ناحية» مرتين النهارده" }, 409);
            me.heading = { day: t, zoneId: str(b.heading.zoneId, 20), active: true, uses: (h.active && h.zoneId === b.heading.zoneId) ? h.uses : (h.uses || 0) + 1 };
          } else {
            me.heading = { ...h, active: false };
          }
        }
        await putDoc(env, "drivers", me.id, me);
        return json({ ok: true, zones: me.zones || [], heading: me.heading || null });
      }

      if (sub === "claim" && method === "POST") {
        const b = await parseBody(request);
        const rid = str(b.requestId, 40);
        if (!rid) return json({ error: "طلب غير محدّد" }, 400);

        const { requests } = await readDocs(env, ["requests"]);
        if (requests.some((r) => r.driverId === me.id && r.status === "assigned"))
          return json({ error: "عندك مشوار شغّال — خلّصه الأول" }, 409);

        const r = await getDoc(env, "requests", rid);
        if (!r) return json({ error: "الطلب غير موجود" }, 404);
        if (r.status !== "pending") return json({ error: "سائق تاني خد المشوار" }, 409);
        if (Date.now() < openAt(r)) return json({ error: "الطلب ده محجوز لبعدين" }, 409);

        /* القبول ذرّي: الشرط جوّه جملة UPDATE نفسها، فأول طلب يوصل للقاعدة هو الفائز */
        const next = { ...r, status: "assigned", driverId: me.id, assignedAt: Date.now() };
        const res = await env.DB.prepare(
          `UPDATE docs SET data=?, updated=?
           WHERE kind='requests' AND id=? AND json_extract(data,'$.status')='pending'`
        ).bind(JSON.stringify(next), Date.now(), rid).run();

        if (!res.meta || res.meta.changes !== 1) return json({ error: "سائق تاني خد المشوار" }, 409);
        return json({ ok: true, ride: (({ code, token, shareToken, riderPhone, bookerPhone, refBy, ...rest }) => rest)(next) });
      }

      if (sub === "start" && method === "POST") {
        const b = await parseBody(request);
        const r = await getDoc(env, "requests", str(b.requestId, 40));
        if (!r) return json({ error: "الطلب غير موجود" }, 404);
        if (r.driverId !== me.id || r.status !== "assigned") return json({ error: "المشوار ده مش بتاعك" }, 403);
        if (!safeEqual(digits(b.code), String(r.code || ""))) return json({ error: "الكود غلط — اسأل الراكب تاني" }, 400);
        await putDoc(env, "requests", r.id, { ...r, startedAt: Date.now() });
        return json({ ok: true });
      }

      if (sub === "finish" && method === "POST") {
        const b = await parseBody(request);
        const rid = str(b.requestId, 40);
        const r = await getDoc(env, "requests", rid);
        if (!r) return json({ error: "الطلب غير موجود" }, 404);
        if (r.driverId !== me.id) return json({ error: "المشوار ده مش بتاعك" }, 403);
        if (r.status !== "assigned") return json({ error: "المشوار اتقفل قبل كده" }, 409);
        if (b.status !== "released" && r.code && !r.startedAt)
          return json({ error: "اكتب كود الركوب الأول علشان تبدأ الرحلة" }, 409);
        /* الترك يرجّع الطلب للسباق بدل ما يضيع على الراكب */
        const next = b.status === "released"
          ? { ...r, status: "pending", driverId: "", assignedAt: null, startedAt: null }
          : { ...r, status: "done", finishedAt: Date.now(), day: todayStr() };
        await putDoc(env, "requests", rid, next);
        return json({ ok: true, status: next.status });
      }

      return json({ error: "غير موجود" }, 404);
    }

    /* ================= الإدارة ================= */

    if (route === "login" && method === "POST") {
      const b = await parseBody(request);
      if (!env.ADMIN_PIN) return json({ error: "الرقم السرّي غير مضبوط على الخادم" }, 500);
      if (!safeEqual(b.pin, env.ADMIN_PIN)) return json({ error: "رقم غير صحيح" }, 401);
      return json({ ok: true });
    }

    if (!isAdmin(request, env)) return json({ error: "غير مصرّح" }, 401);

    if (route === "phone-request" && method === "POST") {
      const out = await createRequest(env, await parseBody(request), "phone");
      return out.error ? json({ error: out.error }, out.status) : json(out);
    }

    if (route === "state" && method === "GET") {
      const all = await readDocs(env, KINDS);
      const now = Date.now();
      all.drivers = all.drivers.map((d) => ({
        ...d, isOnline: d.online !== false && now - (d.lastSeen || 0) < ONLINE_MS,
      }));
      return json(all);
    }

    if (route === "doc") {
      const kind = sub, id = third;
      if (!KINDS.includes(kind) || !id) return json({ error: "مسار غير صحيح" }, 400);
      if (method === "PUT") {
        const b = await parseBody(request);
        if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "بيانات غير صحيحة" }, 400);
        b.id = id;
        await putDoc(env, kind, id, b);
        return json({ ok: true });
      }
      if (method === "DELETE") {
        await env.DB.prepare("DELETE FROM docs WHERE kind=? AND id=?").bind(kind, id).run();
        return json({ ok: true });
      }
    }

    return json({ error: "غير موجود" }, 404);
  } catch (err) {
    const big = err && err.message === "too_large";
    return json({ error: big ? "حجم البيانات كبير" : "خطأ في الخادم" }, big ? 413 : 500);
  }
}
