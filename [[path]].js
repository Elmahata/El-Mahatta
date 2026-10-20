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
 *   POST   /api/consent              عام — تسجيل موافقة على الشروط (الإصدار + الوقت + الرقم + IP)
 *   GET    /api/consents             إدارة — سجل الموافقات
 */

const KINDS = ["zones", "places", "drivers", "requests", "config", "reports", "riders"];
const LOW_BAL = 5; /* أول ما الرصيد يوصل ٥ ج أو أقل، بيظهر بانر «اشحن» */
const PUBLIC_KINDS = ["zones", "places", "config"];
const MAX_BODY = 16 * 1024;
const ONLINE_MS = 90 * 1000;              // يُعتبر السائق أونلاين إن نبض خلال هذه المدة
const CLAIM_WINDOW_MS = 10 * 60 * 1000;   // الطلب اللي محدش أخده خلال ١٠ دقايق بيتلغي لوحده

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

/* نظام الرصيد: السائق بيشحن رصيد كاش عند الإدارة/الوكيل، وكل مشوار بيخلص بيتخصم منه tripFee.
   مجاني لحد ما الإدارة تشغّله (creditOn) وييجي يوم البداية (creditFrom). لو الرصيد أقل من رسم مشوار — الطلبات بتوقف. */
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
async function subCfg(env) {
  const p = (await getDoc(env, "config", "pricing")) || {};
  /* أوتوماتيك: كل مستخدم مجاني ١٢٠ يوم من يوم تسجيله، وبعدها الرصيد بيشتغل لوحده. الإدارة تقدر توقفه مؤقتاً (creditPaused) */
  return { on: !p.creditPaused, freeDays: Number(p.freeDays) > 0 ? Number(p.freeDays) : FREE_DAYS, fee: Number(p.tripFee) > 0 ? Number(p.tripFee) : 1 };
}
const FREE_DAYS = 90;
const joinedOf = (d) => +(d.joinedAt || d.createdAt || 0) || Date.now();
/** حالة رصيد المستخدم (سائق أو راكب): free | ok | low | stopped */
function subState(d, c) {
  const freeTill = joinedOf(d) + c.freeDays * 864e5;
  if (!c.on || Date.now() < freeTill) return { state: "free" };
  const bal = +(d.credit || 0);
  if (bal < c.fee) return { state: "stopped", credit: bal, fee: c.fee };
  return { state: bal <= LOW_BAL ? "low" : "ok", credit: bal, fee: c.fee, trips: Math.floor(bal / c.fee) };
}
/* رصيد الراكب: نفس النظام، والرسم بيتخصم من رصيده مش بيتضاف على الأجرة. المستند بيتحفظ بآخر ١٠ أرقام من الموبايل */
const riderKey = (p) => digits(p).slice(-10);
async function riderWallet(env, phone, c) {
  const k = riderKey(phone);
  let d = await getDoc(env, "riders", k);
  /* أول مرة نشوف الراكب ده = يوم تسجيله (بداية الـ ٣ شهور المجانية) */
  if (!d && k.length >= 9) { d = { id: k, phone: digits(phone), joinedAt: Date.now(), credit: 0 }; await putDoc(env, "riders", k, d); }
  return { doc: d || {}, ...subState(d || {}, c) };
}
const subActive = (d, c) => !c || subState(d, c).state !== "stopped";
const todayStr = () => new Date().toISOString().slice(0, 10);
/* ترتيب السائق: متوسط التقييم + عدد التقييمات (علشان تقييم واحد ٣ نجوم مايظلمش سائق جديد) */
function tierOf(d) {
  const n = d.ratingCount || 0, avg = n ? d.ratingSum / n : 0;
  /* ٣ مستويات: عادي / فضي (٤٫٥ ★ و٣٠ تقييم) / ذهبي (٤٫٨ ★ و١٠٠ تقييم).
     متوسط متوازن: كأن كل سائق بادئ بـ ٥ تقييمات ٥ نجوم، علشان أول تقييم وحش مايظلمهوش.
     بلاغ «طلب أكتر من السعر» اتأكد في آخر ٣٠ يوم (فضي) / ٦٠ يوم (ذهبي) بيمنع المستوى. والإدارة تقدر تنزّله بإيدها. */
  const bal = (d.ratingSum + 25) / (n + 5), now = Date.now(), lastBad = d.lastConfirmedReport || 0;
  const cancels = d.releaseCount || 0, taken = (d.rideCount || n) + cancels, cancelRate = taken ? cancels / taken : 0;
  let t = "normal";
  if (n >= 100 && bal >= 4.8 && cancelRate < 0.05 && now - lastBad > 60 * 864e5) t = "gold";
  else if (n >= 30 && bal >= 4.5 && now - lastBad > 30 * 864e5) t = "silver";
  if (d.tierCap === "normal" || (d.tierCap === "silver" && t === "gold")) t = d.tierCap;
  return { rating: n ? +avg.toFixed(1) : null, ratingCount: n, tier: t };
}
/* وقت القاهرة — للمشاوير الثابتة */
function cairoNow() {
  const s = new Date().toLocaleString("sv-SE", { timeZone: "Africa/Cairo" });
  const asUtc = Date.parse(s.replace(" ", "T") + "Z");
  return { day: s.slice(0, 10), dow: new Date(asUtc).getUTCDay(), off: asUtc - Date.now() };
}
let repeatsRunAt = 0;
async function runRepeats(env) {
  if (Date.now() - repeatsRunAt < 60000) return;
  repeatsRunAt = Date.now();
  const { repeats } = await readDocs(env, ["repeats"]);
  const c = cairoNow();
  for (const rp of repeats || []) {
    if (rp.paused || rp.lastDay === c.day || !(rp.days || []).includes(c.dow)) continue;
    const at = Date.parse(c.day + "T" + rp.time + ":00Z") - c.off;
    const mins = (at - Date.now()) / 60000;
    if (mins < 21 || mins > 55) continue;
    rp.lastDay = c.day;
    const res = await createRequest(env, { ...rp.body, scheduledAt: at }, "repeat");
    rp.current = res && res.ok ? { id: res.id, token: res.token, day: c.day } : null;
    await putDoc(env, "repeats", rp.id, rp);
  }
}

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

/* ===== ربط الأهل: الراكب بيضيف رقم، صاحب الرقم بيوافق من التطبيق، وبعدها بيوصله (ركب / وصل / طوارئ) ===== */
const famId = (rider, fam) => l10(rider) + "_" + l10(fam);
async function pushFam(env, riderPhone, item, onlyAuto) {
  if (!riderPhone) return 0;
  const { links } = await readDocs(env, ["links"]);
  const mine = (links || []).filter((k) => k.rider === l10(riderPhone) && k.status === "ok" && (!onlyAuto || k.auto !== false));
  for (const k of mine) {
    const box = (await getDoc(env, "famalerts", k.fam)) || { id: k.fam, items: [] };
    box.items = box.items.filter((x) => Date.now() - x.at < 864e5).concat([{ id: uid(), at: Date.now(), riderName: k.riderName || "", riderPhone: k.riderPhoneFull || "", ...item }]).slice(-20);
    await putDoc(env, "famalerts", k.fam, box);
    const who = k.riderName || "قريبك";
    const T = {
      sos: ["⚠ طوارئ من " + who, "محتاج مساعدة دلوقتي — دوس علشان تشوف مكانه"],
      start: [who + " ركب توكتوك", "دوس علشان تتابع الرحلة"],
      done: [who + " وصل بالسلامة ✓", ""],
    }[item.type] || ["المحطة", ""];
    await pushTo(env, "rider", k.fam, { kind: item.type === "sos" ? "sos" : "family", title: T[0], body: T[1], url: "/?fam=1", tag: "fam-" + k.rider });
  }
  return mine.length;
}

/* ===== Firebase Cloud Messaging (HTTP v1) — شغال بس لو FCM_SA متحط في Cloudflare ===== */
let FCM_TOK = null;
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uStr = (s) => b64u(new TextEncoder().encode(s));
function fcmSA(env) { try { return env.FCM_SA ? JSON.parse(env.FCM_SA) : null; } catch (e) { return null; } }
async function fcmAccess(sa) {
  if (FCM_TOK && FCM_TOK.exp > Date.now() + 60e3) return FCM_TOK.t;
  const now = Math.floor(Date.now() / 1000);
  const head = b64uStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64uStr(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + body));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + head + "." + body + "." + b64u(sig),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("fcm auth");
  FCM_TOK = { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return FCM_TOK.t;
}
/** يبعت إشعار لصاحب الرقم ده (role: driver | rider). أي غلطة بتتتجاهل — الإشعار إضافة، ومش بيوقف الطلب */
async function pushTo(env, role, phone10, data) {
  const sa = fcmSA(env);
  if (!sa || !phone10) return false;
  try {
    const id = role + "_" + phone10;
    const p = await getDoc(env, "push", id);
    if (!p || !p.token) return false;
    const at = await fcmAccess(sa);
    const strs = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? "")]));
    const r = await fetch("https://fcm.googleapis.com/v1/projects/" + sa.project_id + "/messages:send", {
      method: "POST", headers: { authorization: "Bearer " + at, "content-type": "application/json" },
      body: JSON.stringify({ message: { token: p.token, data: strs, android: { priority: "HIGH" }, webpush: { headers: { Urgency: "high", TTL: data.kind === "request" ? "120" : "600" } } } }),
    });
    if (r.status === 404 || r.status === 400) await env.DB.prepare("DELETE FROM docs WHERE kind=? AND id=?").bind("push", id).run();
    return r.ok;
  } catch (e) { return false; }
}
/* الطلب بيوصل الأول للتكاتك اللي في نص قطر ٥٠٠ متر من مكان الراكب.
   لو محدش قبل خلال دقيقة، الدايرة بتكبر لـ ١٫٥ كم، وبعد دقيقتين بيوصل لكل السواقين (علشان الطلب مايضيعش). */
const RADIUS_M = 500;
const RINGS = [[60e3, RADIUS_M], [120e3, 1500]];
const LOC_FRESH_MS = 3 * 60e3;
function meters(a, b) {
  const R = 6371e3, t = Math.PI / 180, dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
/* أي طلب محدش أخده في ١٠ دقايق بيتلغي من السيرفر نفسه (مش مستني موبايل الراكب) */
async function expireStale(env, requests) {
  const now = Date.now(), stale = requests.filter((r) => r.status === "pending" && now - openAt(r) >= CLAIM_WINDOW_MS && now >= openAt(r));
  for (const r of stale.slice(0, 25)) {
    r.status = "cancelled"; r.cancelReason = "expired"; r.cancelledBy = "system"; r.cancelledAt = now;
    try { await putDoc(env, "requests", r.id, r); } catch (e) {}
  }
  return stale.length;
}
/* ===== أكتر من سائق يوافق، والراكب يختار =====
   السائق بيدوس «وافق» ← بيتضاف لـ offers. الراكب بيشوفهم مترتبين من الأقرب ويختار.
   لو الراكب مااختارش في دقيقة من أول موافقة، السيرفر بيختار الأقرب لوحده. */
const AUTO_PICK_MS = 60 * 1000;
const MAX_OFFERS = 8;
function liveOffers(r, drivers, busy) {
  const now = Date.now(), byId = new Map(drivers.map((d) => [d.id, d]));
  return (r.offers || []).map((o) => {
    const d = byId.get(o.d);
    if (!d || busy.has(d.id) || d.online === false || d.active === false || now - (d.lastSeen || 0) > 3 * 60e3) return null;
    const loc = d.loc && now - d.loc.at < LOC_FRESH_MS ? d.loc : null;
    const m = loc && r.from && isFinite(+r.from.lat) ? Math.round(meters(r.from, loc)) : o.distM;
    return { d, at: o.at, distM: m != null ? m : null, etaMin: m != null ? Math.max(1, Math.round((m * 1.3) / 250)) : null };
  }).filter(Boolean).sort((a, b) => (a.distM ?? 1e9) - (b.distM ?? 1e9) || a.at - b.at);
}
const busySet = (requests) => new Set(requests.filter((x) => x.status === "assigned" && x.driverId).map((x) => x.driverId));
/* التعيين ذرّي: أول تحديث يوصل والطلب لسه pending هو اللي بيكسب */
async function assignTo(env, r, d) {
  const next = { ...r, status: "assigned", driverId: d.id, assignedAt: Date.now() };
  const res = await env.DB.prepare(
    `UPDATE docs SET data=?, updated=? WHERE kind='requests' AND id=? AND json_extract(data,'$.status')='pending'`
  ).bind(JSON.stringify(next), Date.now(), r.id).run();
  if (!res.meta || res.meta.changes !== 1) return null;
  try { await pushTo(env, "driver", l10(d.phone), { kind: "ride", title: "الراكب اختارك ✓", body: "روح للراكب — " + ((r.from && r.from.label) || ""), url: "/driver.html", tag: "ride-" + r.id }); } catch (e) {}
  try { await pushTo(env, "rider", l10(next.bookerPhone || next.riderPhone), { kind: "ride", title: d.name + " جاي ليك", body: "السعر " + next.fare + " ج — افتح علشان تشوفه على الخريطة", url: "/", tag: "ride-" + r.id }); } catch (e) {}
  return next;
}
async function autoPick(env, r, drivers, requests) {
  if (r.status !== "pending" || !(r.offers || []).length || Date.now() - r.offers[0].at < AUTO_PICK_MS) return null;
  const best = liveOffers(r, drivers, busySet(requests))[0];
  return best ? assignTo(env, r, best.d) : null;
}

function reachM(age) { for (const [ms, m] of RINGS) if (age < ms) return m; return Infinity; }
/** هل السائق ده جوه دايرة الطلب دلوقتي؟ age = بقاله قد إيه مفتوح */
function inReach(r, d, age) {
  const lim = reachM(age);
  if (lim === Infinity) return true;
  if (!r.from || !isFinite(+r.from.lat) || !isFinite(+r.from.lng)) return true;
  if (!d.loc || Date.now() - d.loc.at > LOC_FRESH_MS) return false;
  return meters(r.from, d.loc) <= lim;
}
/* طلب جديد: إشعار لكل سائق أونلاين مش في مشوار، وفي نص قطر ٥٠٠ متر من الراكب */
async function pushDrivers(env, r) {
  if (!fcmSA(env)) return;
  try {
    const { drivers, requests } = await readDocs(env, ["drivers", "requests"]);
    const busy = new Set(requests.filter((x) => x.status === "assigned").map((x) => x.driverId));
    const list = drivers.filter((d) => d.active !== false && d.online !== false && !busy.has(d.id) && Date.now() - (d.lastSeen || 0) < 12 * 3600e3 && inReach(r, d, 0));
    const body = (r.from && r.from.label ? r.from.label : "") + " ← " + (r.to && r.to.label ? r.to.label : "") + " · " + r.fare + " ج";
    await Promise.all(list.map((d) => pushTo(env, "driver", l10(d.phone), { kind: "request", title: "طلب جديد · " + r.fare + " ج", body, url: "/driver.html", tag: "req" })));
  } catch (e) {}
}

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

  const { places, config, zones = [] } = await readDocs(env, PUBLIC_KINDS);
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
  /* سعر خاص لكل منطقة (لو الإدارة حددته) — للتوسع لمراكز تانية */
  const zf = zones.find((z) => z.id === from.zoneId), zt = zones.find((z) => z.id === to.zoneId);
  if (same && zf && Number(zf.same) > 0) fare = Number(zf.same);
  if (!same) { const zc = Math.max(Number(zf && zf.cross) || 0, Number(zt && zt.cross) || 0); if (zc > 0) fare = zc; }
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
  /* نظام الرصيد للراكب: لو شغال ورصيده أقل من رسم المشوار، مايقدرش يطلب من التطبيق (طلب التليفون من الإدارة بيعدّي) */
  if (source === "app") {
    const sc = await subCfg(env);
    const w = await riderWallet(env, b.forOther ? digits(b.bookerPhone) : phone, sc);
    if (w.state === "stopped") return { error: "رصيدك خلص — اشحن من الإدارة أو الوكيل علشان تطلب", status: 403 };
  }
  const discount = Math.min(refDiscount, fare - 5 > 0 ? refDiscount : 0);
  fare -= discount;

  const id = uid(), tok = newToken(), share = newToken().slice(0, 12);
  await putDoc(env, "requests", id, {
    id, token: tok, shareToken: share, code: rideCode(), source,
    riderName: name, riderPhone: phone, note: str(b.note, 140), from, to, ip: str(b.__ip, 64),
    fare, sameZone: same, status: "pending", driverId: "",
    createdAt: now, day: todayStr(), scheduledAt,
    forOther: Boolean(b.forOther), bookerPhone: b.forOther ? digits(b.bookerPhone).slice(0, 15) : "",
    discount, refBy: discount && refBy ? refBy : "", refCredit: Boolean(discount && !refBy),
  });
  if (!scheduledAt || scheduledAt - now < 15 * 60e3) await pushDrivers(env, { from, to, fare });
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

    if (route === "public" && method === "GET") {
      const pub = await readDocs(env, PUBLIC_KINDS);
      /* الأماكن اللي اتحددت تلقائياً وطلعت بعيد عن البلد (أكتر من ٤ كم) مابتظهرش للراكب لحد ما الإدارة تراجعها */
      if (Array.isArray(pub.places)) {
        const C = { lat: 30.7964, lng: 31.6261 };
        pub.places = pub.places.filter((p) => !p.auto || p.lat == null || meters(C, { lat: +p.lat, lng: +p.lng }) <= 4000);
      }
      return json(pub);
    }

    /* سجل الموافقة على الشروط — دليل إن المستخدم وافق (إمتى، وعلى أنهي إصدار، ومن أنهي جهاز) */
    if (route === "consent" && method === "POST") {
      const b = await parseBody(request);
      const role = b.role === "driver" ? "driver" : "rider";
      const v = str(b.v, 10), device = str(b.device, 40).replace(/[^\w-]/g, "");
      if (!v || device.length < 8) return json({ error: "بيانات ناقصة" }, 400);
      const id = role + "-" + device + "-" + v;
      const old = (await getDoc(env, "consents", id)) || {};
      const phone = digits(b.phone).slice(0, 15) || old.phone || "";
      await putDoc(env, "consents", id, {
        id, role, v, device, phone,
        acceptedAt: old.acceptedAt || str(b.at, 40), serverAt: old.serverAt || Date.now(),
        linkedAt: phone && !old.phone ? Date.now() : (old.linkedAt || 0),
        ip: old.ip || str(request.headers.get("cf-connecting-ip"), 64), ua: old.ua || str(request.headers.get("user-agent"), 200),
      });
      return json({ ok: true });
    }

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
      /* ضد الطلبات الوهمية: ٣ طلبات مفتوحة بالكتير لكل رقم، وطلب واحد كل دقيقة من نفس الرقم أو الموبايل */
      const ip = str(request.headers.get("CF-Connecting-IP"), 64);
      const rp = digits(b.riderPhone).slice(0, 15);
      const { requests: allR } = await readDocs(env, ["requests"]);
      if (allR.filter((r) => r.riderPhone === rp && (r.status === "pending" || r.status === "assigned")).length >= 3)
        return json({ error: "عندك ٣ طلبات مفتوحة — استنى أو الغي واحد الأول" }, 429);
      if (allR.some((r) => (r.riderPhone === rp || (ip && r.ip === ip)) && Date.now() - (r.createdAt || 0) < 60000))
        return json({ error: "استنى دقيقة قبل ما تطلب تاني" }, 429);
      b.__ip = ip;
      const out = await createRequest(env, b, "app");
      return out.error ? json({ error: out.error }, out.status) : json(out);
    }

    /* التكاتك القريبة للراكب: أونلاين + فاضية + مكانها وصل من دقيقتين. المكان تقريبي (~١٠٠ م) ومن غير أي اسم أو رقم */
    if (route === "nearby" && method === "GET") {
      const lat = +url.searchParams.get("lat"), lng = +url.searchParams.get("lng");
      const { drivers, requests } = await readDocs(env, ["drivers", "requests"]);
      const busy = new Set(requests.filter((r) => r.status === "assigned" && r.driverId).map((r) => r.driverId));
      const now = Date.now(), hour = Math.floor(now / 36e5);
      const hash = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; };
      const out = drivers.filter((d) => d.active !== false && d.online !== false && d.lastSeen && now - d.lastSeen < ONLINE_MS && d.loc && now - d.loc.at < 2 * 60 * 1000 && !busy.has(d.id))
        .map((d) => {
          const h = hash(d.id + ":" + hour), ox = ((h & 0xff) / 255 - 0.5) * 0.0018, oy = (((h >> 8) & 0xff) / 255 - 0.5) * 0.0018;
          return { k: (hash(d.id) >>> 0).toString(36), lat: +(d.loc.lat + oy).toFixed(5), lng: +(d.loc.lng + ox).toFixed(5), h: d.loc.h };
        })
        .filter((p) => !isFinite(lat) || !isFinite(lng) || (Math.abs(p.lat - lat) < 0.05 && Math.abs(p.lng - lng) < 0.05))
        .slice(0, 25);
      return json({ count: out.length, drivers: out });
    }

    /* متابعة الراكب — بيانات السائق تظهر فقط بعد ما يَقبل */
    if (route === "track" && sub && method === "GET") {
      const r = await getDoc(env, "requests", str(sub, 40));
      if (!r) return json({ error: "طلب غير موجود" }, 404);
      if (!r.token || !safeEqual(url.searchParams.get("token"), r.token))
        return json({ error: "غير مصرّح" }, 401);
      if (r.status === "pending" && Date.now() - openAt(r) >= CLAIM_WINDOW_MS) {
        r.status = "cancelled"; r.cancelReason = "expired"; r.cancelledBy = "system"; r.cancelledAt = Date.now();
        await putDoc(env, "requests", r.id, r);
      }
      let offers = [], autoAt = null;
      if (r.status === "pending" && (r.offers || []).length) {
        const { drivers, requests } = await readDocs(env, ["drivers", "requests"]);
        const picked = await autoPick(env, r, drivers, requests);
        if (picked) Object.assign(r, picked);
        else {
          autoAt = r.offers[0].at + AUTO_PICK_MS;
          offers = liveOffers(r, drivers, busySet(requests)).map((x) => ({
            id: x.d.id, name: (x.d.name || "").trim().split(/\s+/)[0] || "سائق", photo: x.d.photo || "",
            distM: x.distM, etaMin: x.etaMin, ...tierOf(x.d),
          }));
        }
      }
      let driver = null, driverLoc = null;
      if (r.driverId && r.status === "assigned") {
        const d = await getDoc(env, "drivers", r.driverId);
        if (d) {
          driver = { name: d.name, plate: d.plate, photo: d.photo || "", village: d.village || "", ...tierOf(d) };
          if (d.loc && Date.now() - d.loc.at < 2 * 60 * 1000) driverLoc = d.loc;
        }
      }
      const pt = (p) => (p && p.lat != null ? { lat: p.lat, lng: p.lng, label: p.label } : null);
      return json({
        id: r.id, status: r.status, fare: r.fare, driver, driverLoc, from: pt(r.from), to: pt(r.to), createdAt: r.createdAt, assignedAt: r.assignedAt || null, scheduledAt: r.scheduledAt || null, discount: r.discount || 0,
        code: r.status === "assigned" ? r.code : null, startedAt: r.startedAt || null,
        arrivedAt: r.arrivedAt || null, cancelReason: r.cancelReason || null,
        shareToken: r.shareToken || null, reported: Boolean(r.reported),
        offers, autoPickAt: autoAt, now: Date.now(),
      });
    }

    /* الراكب بيختار سائق من اللي وافقوا */
    if (route === "pick" && method === "POST") {
      const b = await parseBody(request);
      const r = await getDoc(env, "requests", str(b.id, 40));
      if (!r || !r.token || !safeEqual(b.token, r.token)) return json({ error: "غير مصرّح" }, 401);
      if (r.status !== "pending") return json({ error: "الطلب اتقفل خلاص" }, 409);
      const { drivers, requests } = await readDocs(env, ["drivers", "requests"]);
      const o = liveOffers(r, drivers, busySet(requests)).find((x) => x.d.id === str(b.driverId, 40));
      if (!o) return json({ error: "السائق ده مابقاش متاح — اختار حد تاني" }, 409);
      const next = await assignTo(env, r, o.d);
      if (!next) return json({ error: "الطلب اتقفل خلاص" }, 409);
      return json({ ok: true });
    }

    /* «شارك رحلتك»: الأهل يشوفوا الحالة واسم السائق ولوحته — من غير أي أرقام تليفونات */
    if (route === "share" && sub && method === "GET") {
      const r = await getDoc(env, "requests", str(sub, 40));
      if (!r || !tokOk(url.searchParams.get("s"), r.shareToken)) return json({ error: "اللينك ده مش صحيح" }, 404);
      let driver = null;
      if (r.driverId) {
        const d = await getDoc(env, "drivers", r.driverId);
        if (d) driver = { name: d.name, plate: d.plate, photo: d.photo || "", village: d.village || "" };
      }
      const first = (r.riderName || "").trim().split(/\s+/)[0] || "";
      return json({
        status: r.status, rider: first,
        from: { label: r.from.label, lat: r.from.lat, lng: r.from.lng },
        to: { label: r.to.label, lat: r.to.lat, lng: r.to.lng }, driver,
        createdAt: r.createdAt, assignedAt: r.assignedAt || null, startedAt: r.startedAt || null, finishedAt: r.finishedAt || null,
      });
    }

    /* الراكب يلغي — أو يرجّع الطلب للسواقين التانيين لو السائق اتأخر */
    if (route === "rider-cancel" && method === "POST") {
      const b = await parseBody(request);
      const r = await getDoc(env, "requests", str(b.id, 40));
      if (!r || !r.token || !safeEqual(b.token, r.token)) return json({ error: "غير مصرّح" }, 401);
      if (r.status === "done" || r.status === "cancelled") return json({ ok: true, status: r.status });
      if (r.startedAt) return json({ error: "الرحلة بدأت خلاص — مينفعش تتلغي" }, 409);
      const reason = ["changed", "late", "noshow", "wrong", "other"].includes(b.reason) ? b.reason : "other";
      if (r.driverId && (reason === "late" || reason === "noshow")) {
        const d = await getDoc(env, "drivers", r.driverId);
        if (d) await putDoc(env, "drivers", d.id, { ...d, lateCount: (d.lateCount || 0) + 1, lateLog: [...(d.lateLog || []), { at: Date.now(), rid: r.id }].slice(-20) });
      }
      if (b.rebook && r.status === "assigned" && !r.startedAt) {
        await putDoc(env, "requests", r.id, { ...r, status: "pending", driverId: "", assignedAt: null, offers: [], skipDrivers: [...(r.skipDrivers || []), r.driverId].slice(-5), rebooked: (r.rebooked || 0) + 1 });
        return json({ ok: true, status: "pending" });
      }
      await putDoc(env, "requests", r.id, { ...r, status: "cancelled", cancelledBy: "rider", cancelReason: reason, cancelledAt: Date.now() });
      return json({ ok: true, status: "cancelled" });
    }

    /* احذف حسابي: بيمسح اسم الراكب ورقمه من كل رحلاته اللي خلصت (المفتوحة بتتلغي) */
    if (route === "delete-account" && method === "POST") {
      const b = await parseBody(request);
      const phone = digits(b.phone).slice(0, 15);
      if (phone.length < 9) return json({ error: "اكتب رقمك" }, 400);
      const deny = await needSession(request, env, phone, "rider");
      if (deny) return deny;
      const { requests } = await readDocs(env, ["requests"]);
      let n = 0;
      for (const r of requests.filter((x) => x.riderPhone === phone)) {
        const open = r.status === "pending" || r.status === "assigned";
        await putDoc(env, "requests", r.id, { ...r, riderName: "(محذوف)", riderPhone: "", note: "", bookerPhone: "", ip: "", ...(open ? { status: "cancelled", cancelledBy: "rider", cancelReason: "deleted" } : {}) });
        n++;
      }
      return json({ ok: true, cleared: n });
    }

    /* تقييم السائق بعد الرحلة — مرة واحدة لكل رحلة */
    if (route === "rate" && method === "POST") {
      const b = await parseBody(request);
      const r = await getDoc(env, "requests", str(b.id, 40));
      if (!r || !tokOk(b.token, r.token)) return json({ error: "غير مصرّح" }, 401);
      if (r.status !== "done" || !r.driverId) return json({ error: "التقييم بعد ما الرحلة تخلص" }, 409);
      if (r.rating) return json({ error: "قيّمت الرحلة دي قبل كده" }, 409);
      const stars = Math.max(1, Math.min(5, parseInt(b.stars, 10) || 0));
      const note = str(b.note, 200), tags = (Array.isArray(b.tags) ? b.tags : []).map((x) => str(x, 30)).slice(0, 5);
      await putDoc(env, "requests", r.id, { ...r, rating: stars, ratingNote: note, ratingTags: tags });
      const d = await getDoc(env, "drivers", r.driverId);
      if (d) await putDoc(env, "drivers", d.id, { ...d, ratingSum: (d.ratingSum || 0) + stars, ratingCount: (d.ratingCount || 0) + 1,
        reviews: (d.reviews || []).concat(note || tags.length ? [{ s: stars, n: note, t: tags, at: Date.now() }] : []).slice(-30) });
      return json({ ok: true });
    }

    /* ===== مشوار كل يوم: الطلب بيتعمل لوحده قبل المعاد بـ ٢١–٥٥ دقيقة ===== */
    if (route === "repeat") {
      const b = method === "GET" ? Object.fromEntries(new URL(request.url).searchParams) : await parseBody(request);
      const phone = digits(b.phone);
      if (phone.length < 10) return json({ error: "اكتب رقمك في البروفايل الأول" }, 400);
      const deny = await needSession(request, env, phone, "rider");
      if (deny) return deny;
      const { repeats } = await readDocs(env, ["repeats"]);
      const mine = (repeats || []).filter((x) => l10(x.phone) === l10(phone));
      const c = cairoNow();
      if (!sub && method === "GET") {
        const cur = mine.map((x) => x.current).find((x) => x && x.day === c.day) || null;
        return json({ items: mine.map((x) => ({ id: x.id, time: x.time, days: x.days, from: x.body.from && x.body.from.label, to: x.body.to && x.body.to.label, paused: !!x.paused })), current: cur });
      }
      if (sub === "add" && method === "POST") {
        if (mine.length >= 3) return json({ error: "أقصى حاجة ٣ مشاوير ثابتة" }, 400);
        const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time) ? b.time : "";
        const days = (Array.isArray(b.days) ? b.days : []).map(Number).filter((n) => n >= 0 && n <= 6);
        if (!time || !days.length) return json({ error: "اختار المعاد والأيام" }, 400);
        if (!b.from || !b.to) return json({ error: "حدّد مكان الركوب والوجهة" }, 400);
        const id = uid();
        const leg = (p) => ({ lat: +p.lat, lng: +p.lng, label: str(p.label, 80) });
        await putDoc(env, "repeats", id, { id, phone, time, days, lastDay: "", body: { riderName: str(b.name, 60), riderPhone: phone, note: str(b.note, 140), from: leg(b.from), to: leg(b.to) }, at: Date.now() });
        return json({ ok: true });
      }
      if (sub === "remove" && method === "POST") {
        const x = mine.find((r) => r.id === str(b.id, 40));
        if (x) await env.DB.prepare("DELETE FROM docs WHERE kind=? AND id=?").bind("repeats", x.id).run();
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    }

    /* تسجيل توكن الإشعارات للموبايل ده */
    if (route === "push" && sub === "register" && method === "POST") {
      const b = await parseBody(request);
      const token = str(b.token, 400);
      if (token.length < 20) return json({ error: "توكن غلط" }, 400);
      let phone = "";
      if (b.role === "driver") {
        const d = await getDriver(request, env);
        if (!d) return json({ error: "ادخل الأول" }, 401);
        phone = d.phone;
      } else {
        phone = digits(b.phone);
        if (phone.length < 10) return json({ error: "رقمك مش متسجّل" }, 400);
        const deny = await needSession(request, env, phone, "rider");
        if (deny) return deny;
      }
      const role = b.role === "driver" ? "driver" : "rider";
      await putDoc(env, "push", role + "_" + l10(phone), { token, at: Date.now() });
      return json({ ok: true });
    }

    /* ===== الأهل ===== */
    if (route === "family") {
      const b = method === "GET" ? Object.fromEntries(new URL(request.url).searchParams) : await parseBody(request);
      const phone = digits(b.phone);
      if (phone.length < 10) return json({ error: "رقمك مش متسجّل — اكتبه في البروفايل" }, 400);
      const deny = await needSession(request, env, phone, "rider");
      if (deny) return deny;
      const me = l10(phone);
      const { links } = await readDocs(env, ["links"]);
      const all = links || [];
      const view = (k) => ({ id: k.id, status: k.status, auto: k.auto !== false, riderName: k.riderName, famName: k.famName || "", fam: "0" + k.fam, rider: "0" + k.rider, riderPhone: k.status === "ok" ? k.riderPhoneFull : "" });

      if (!sub && method === "GET") {
        return json({
          mine: all.filter((k) => k.rider === me).map(view),
          invites: all.filter((k) => k.fam === me && k.status === "pending").map(view),
          watching: all.filter((k) => k.fam === me && k.status === "ok").map(view),
        });
      }
      if (sub === "add" && method === "POST") {
        const fam = digits(b.fam);
        if (!/^01\d{9}$/.test(fam)) return json({ error: "اكتب رقم موبايل مصري صحيح" }, 400);
        if (l10(fam) === me) return json({ error: "ده رقمك إنت" }, 400);
        if (all.filter((k) => k.rider === me).length >= 3) return json({ error: "أقصى حاجة ٣ أرقام" }, 400);
        const id = famId(phone, fam);
        const old = all.find((k) => k.id === id);
        if (old) return json({ ok: true, link: view(old) });
        const k = { id, rider: me, fam: l10(fam), riderName: str(b.name, 60), famName: str(b.famName, 40), riderPhoneFull: phone, status: "pending", auto: true, at: Date.now() };
        await putDoc(env, "links", id, k);
        return json({ ok: true, link: view(k) });
      }
      if (sub === "answer" && method === "POST") {
        const k = all.find((x) => x.id === str(b.id, 40) && x.fam === me);
        if (!k) return json({ error: "الطلب مش موجود" }, 404);
        if (b.ok) await putDoc(env, "links", k.id, { ...k, status: "ok", okAt: Date.now() });
        else await env.DB.prepare("DELETE FROM docs WHERE kind=? AND id=?").bind("links", k.id).run();
        return json({ ok: true });
      }
      if (sub === "remove" && method === "POST") {
        const k = all.find((x) => x.id === str(b.id, 40) && (x.fam === me || x.rider === me));
        if (k) await env.DB.prepare("DELETE FROM docs WHERE kind=? AND id=?").bind("links", k.id).run();
        return json({ ok: true });
      }
      if (sub === "auto" && method === "POST") {
        const k = all.find((x) => x.id === str(b.id, 40) && x.rider === me);
        if (!k) return json({ error: "مش موجود" }, 404);
        await putDoc(env, "links", k.id, { ...k, auto: Boolean(b.auto) });
        return json({ ok: true });
      }
      if (sub === "alerts" && method === "GET") {
        const box = (await getDoc(env, "famalerts", me)) || { items: [] };
        const since = +b.since || 0;
        return json({ items: box.items.filter((x) => x.at > since), invites: all.filter((k) => k.fam === me && k.status === "pending").length, now: Date.now() });
      }
      if (sub === "sos" && method === "POST") {
        const r = await getDoc(env, "requests", str(b.requestId, 40));
        if (!r || !safeEqual(str(b.token, 80), String(r.token || "")) || l10(r.riderPhone) !== me) return json({ error: "الرحلة مش موجودة" }, 404);
        const d = r.driverId ? await getDoc(env, "drivers", r.driverId) : null;
        const lat = +b.lat, lng = +b.lng;
        const n = await pushFam(env, r.riderPhone, {
          type: "sos", requestId: r.id, share: r.shareToken || "", driver: d ? d.name + (d.plate ? " · لوحة " + d.plate : "") : "",
          loc: isFinite(lat) && isFinite(lng) && lat ? { lat, lng } : null,
        }, false);
        await putDoc(env, "requests", r.id, { ...r, sosAt: Date.now() });
        return json({ ok: true, sent: n });
      }
      return json({ error: "not found" }, 404);
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

    /* رصيد الشحن للراكب — بيرجّع free طول ما النظام مقفول أو في الفترة المجانية */
    if (route === "wallet" && method === "GET") {
      const phone = digits(url.searchParams.get("phone"));
      if (phone.length < 9) return json({ error: "رقم غير صحيح" }, 400);
      const w = await riderWallet(env, phone, await subCfg(env));
      return json(w.state === "low" || w.state === "stopped" ? { state: w.state, credit: w.credit, fee: w.fee } : { state: "free" });
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
      const open = r.driverId && (r.status === "assigned" || (r.status === "done" && Date.now() - (r.finishedAt || 0) < 5 * 60 * 1000));
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
          c.s = c.s.filter((x) => now - x.at < 5 * 60 * 1000).concat([{ i: uid(), f: who, type: t, call: str(b.sig.call, 20), sdp: String(b.sig.sdp ?? "").slice(0, 15000), at: now }]).slice(-20);
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
        if (!subActive(d, await subCfg(env))) return json({ error: "رصيدك خلص — اشحن من الإدارة علشان تستقبل مشاوير" }, 403);
        return json({ ok: true, driver: { id: d.id, name: d.name, plate: d.plate } });
      }

      const me = await getDriver(request, env);
      if (!me) return json({ error: "غير مصرّح" }, 401);
      const sc = await subCfg(env);
      const ss = subState(me, sc);
      if (!me.joinedAt && !me.createdAt) { me.joinedAt = Date.now(); await putDoc(env, "drivers", me.id, me); }
      /* السائق اللي اشتراكه وقف يقدر يفتح الصفحة ويشوف الرسالة، بس مايقدرش ياخد مشاوير */
      if (ss.state === "stopped" && !(method === "GET") && sub !== "online" && sub !== "loc" && sub !== "finish" && sub !== "start") return json({ error: "رصيدك خلص — اشحن من الإدارة علشان تاخد مشاوير" }, 403);

      /* مكان السائق لايف — بيتبعت وهو في مشوار بس، والراكب بيشوفه من /api/track */
      if (sub === "loc" && method === "POST") {
        const b = await parseBody(request);
        const lat = +b.lat, lng = +b.lng;
        if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return json({ error: "مكان غير صحيح" }, 400);
        if (me.loc && Date.now() - me.loc.at < 4000) return json({ ok: true });
        me.loc = { lat: +lat.toFixed(6), lng: +lng.toFixed(6), h: b.h != null && isFinite(+b.h) ? Math.round(+b.h) : null, at: Date.now(), idle: Boolean(b.idle) };
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
        try { await runRepeats(env); } catch (e) {}
        /* بنكتب «آخر ظهور» مرة كل ٣٠ ثانية بس — الكتابة كل ٤ ثواني كانت بتعمل ضغط (503) */
        if (Date.now() - (me.lastSeen || 0) > 30000) { me.lastSeen = Date.now(); await putDoc(env, "drivers", me.id, me); }
        const { requests } = await readDocs(env, ["requests"]);
        const now = Date.now();
        if (now - (globalThis.__mhSweep || 0) > 60000) { globalThis.__mhSweep = now; try { await expireStale(env, requests); } catch (e) {} }
        /* الراكب مااختارش في دقيقة؟ نختار الأقرب له */
        const due = requests.filter((r) => r.status === "pending" && (r.offers || []).length && now - r.offers[0].at >= AUTO_PICK_MS);
        if (due.length && now - (globalThis.__mhPick || 0) > 8000) {
          globalThis.__mhPick = now;
          try {
            const { drivers } = await readDocs(env, ["drivers"]);
            for (const r of due.slice(0, 10)) { const n = await autoPick(env, r, drivers, requests); if (n) Object.assign(r, n); }
          } catch (e) {}
        }

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
          .filter((r) => !(r.skipDrivers || []).includes(me.id))
          .filter((r) => inReach(r, me, now - openAt(r)))
          .filter((r) => now - openAt(r) >= PRIORITY_MS || zones.includes(r.from && r.from.zoneId));
        /* مشوار واحد بس: لو عنده مشوار شغال مابيشوفش طلبات تانية. والطلبات مترتبة من الأقرب لمكانه */
        const myLoc = me.loc && now - me.loc.at < LOC_FRESH_MS ? me.loc : null;
        const far = (r) => myLoc && r.from && isFinite(+r.from.lat) ? meters(r.from, myLoc) : Infinity;
        const available = (mineFull ? [] : open)
          .filter((r) => !heading || (r.to && r.to.zoneId === heading.zoneId))
          .sort((a, b) => (far(a) - far(b)) || (openAt(b) - openAt(a)))
          .slice(0, 20)
          .map((r) => ({ ...teaser(r), distM: isFinite(far(r)) ? Math.round(far(r)) : null, offered: (r.offers || []).some((o) => o.d === me.id), offers: (r.offers || []).length }));
        const hidden = open.length - available.length;

        const done = requests.filter((r) => r.driverId === me.id && r.status === "done" && r.day === todayStr());
        return json({
          me: { id: me.id, name: me.name, plate: me.plate, online: me.online !== false, zones, heading, ...tierOf(me) },
          sub: ss,
          available: blocked ? [] : available, mine, hidden,
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
          days, rating: me.ratingCount ? +(me.ratingSum / me.ratingCount).toFixed(1) : null, ratingCount: me.ratingCount || 0, tier: tierOf(me).tier,
          reviews: (me.reviews || []).slice(-8).reverse(),
          sub: ss, paidLog: (me.creditLog || []).filter((x) => x.t === "topup").slice(-6).reverse(),
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

        /* طلبات التطبيق: موافقة بس، والراكب هو اللي بيختار. طلبات التليفون (الإدارة): أول واحد ياخدها */
        if (r.source !== "phone") {
          const offers = Array.isArray(r.offers) ? r.offers : [];
          if (offers.some((o) => o.d === me.id)) return json({ ok: true, offered: true });
          if (offers.length >= MAX_OFFERS) return json({ error: "الراكب وصله موافقات كفاية" }, 409);
          const myLoc = me.loc && Date.now() - me.loc.at < LOC_FRESH_MS ? me.loc : null;
          const o = { d: me.id, at: Date.now(), distM: myLoc && r.from && isFinite(+r.from.lat) ? Math.round(meters(r.from, myLoc)) : null };
          const res = await env.DB.prepare(
            `UPDATE docs SET data=json_insert(json_set(data,'$.offers',json(coalesce(json_extract(data,'$.offers'),'[]'))),'$.offers[#]',json(?)), updated=?
             WHERE kind='requests' AND id=? AND json_extract(data,'$.status')='pending'`
          ).bind(JSON.stringify(o), Date.now(), rid).run();
          if (!res.meta || res.meta.changes !== 1) return json({ error: "الطلب اتقفل" }, 409);
          if (!offers.length) try { await pushTo(env, "rider", l10(r.bookerPhone || r.riderPhone), { kind: "ride", title: "سواقين وافقوا على طلبك 🛺", body: "افتح واختار السائق اللي يناسبك", url: "/", tag: "ride-" + rid }); } catch (e) {}
          return json({ ok: true, offered: true });
        }

        /* القبول ذرّي: الشرط جوّه جملة UPDATE نفسها، فأول طلب يوصل للقاعدة هو الفائز */
        const next = { ...r, status: "assigned", driverId: me.id, assignedAt: Date.now() };
        const res = await env.DB.prepare(
          `UPDATE docs SET data=?, updated=?
           WHERE kind='requests' AND id=? AND json_extract(data,'$.status')='pending'`
        ).bind(JSON.stringify(next), Date.now(), rid).run();

        if (!res.meta || res.meta.changes !== 1) return json({ error: "سائق تاني خد المشوار" }, 409);
        await pushTo(env, "rider", l10(next.bookerPhone || next.riderPhone), { kind: "ride", title: me.name + " جاي ليك", body: "السعر " + next.fare + " ج — افتح علشان تشوفه على الخريطة", url: "/", tag: "ride-" + rid });
        return json({ ok: true, ride: (({ code, token, shareToken, riderPhone, bookerPhone, refBy, ...rest }) => rest)(next) });
      }

      /* السائق وصل عند الراكب — الراكب بيشوف arrivedAt من /api/track وبيجيله تنبيه + عدّاد ٣ دقايق */
      if (sub === "arrived" && method === "POST") {
        const b = await parseBody(request);
        const r = await getDoc(env, "requests", str(b.requestId, 40));
        if (!r) return json({ error: "الطلب غير موجود" }, 404);
        if (r.driverId !== me.id || r.status !== "assigned") return json({ error: "المشوار ده مش بتاعك" }, 403);
        if (r.startedAt) return json({ error: "الرحلة بدأت خلاص" }, 409);
        if (!r.arrivedAt) {
          await putDoc(env, "requests", r.id, { ...r, arrivedAt: Date.now() });
          await pushTo(env, "rider", l10(r.bookerPhone || r.riderPhone), { kind: "ride", title: "السائق وصل عندك 📍", body: me.name + " مستنيك — قدامك ٣ دقايق", url: "/", tag: "ride-" + r.id });
        }
        return json({ ok: true });
      }

      /* الراكب ماجاش: مسموح بس بعد ٣ دقايق من «وصلت»، ومفيش رسم بيتخصم */
      if (sub === "noshow" && method === "POST") {
        const b = await parseBody(request);
        const r = await getDoc(env, "requests", str(b.requestId, 40));
        if (!r) return json({ error: "الطلب غير موجود" }, 404);
        if (r.driverId !== me.id || r.status !== "assigned" || r.startedAt) return json({ error: "المشوار ده مش بتاعك" }, 403);
        if (!r.arrivedAt || Date.now() - r.arrivedAt < 3 * 60000 - 5000) return json({ error: "استنى لحد ما الـ ٣ دقايق يخلصوا" }, 409);
        await putDoc(env, "requests", r.id, { ...r, status: "cancelled", cancelReason: "noshow", cancelledAt: Date.now() });
        return json({ ok: true });
      }

      if (sub === "start" && method === "POST") {
        const b = await parseBody(request);
        const r = await getDoc(env, "requests", str(b.requestId, 40));
        if (!r) return json({ error: "الطلب غير موجود" }, 404);
        if (r.driverId !== me.id || r.status !== "assigned") return json({ error: "المشوار ده مش بتاعك" }, 403);
        if (!safeEqual(digits(b.code), String(r.code || ""))) return json({ error: "الكود غلط — اسأل الراكب تاني" }, 400);
        await putDoc(env, "requests", r.id, { ...r, startedAt: Date.now() });
        const dd = me;
        try { await pushFam(env, r.bookerPhone || r.riderPhone, { type: "start", requestId: r.id, share: r.shareToken || "", driver: dd.name + (dd.plate ? " · لوحة " + dd.plate : ""), to: r.to && r.to.label }, true); } catch (e) {}
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
          ? { ...r, status: "pending", driverId: "", assignedAt: null, startedAt: null, arrivedAt: null }
          : { ...r, status: "done", finishedAt: Date.now(), day: todayStr() };
        /* عدّادات المستوى: كام مشوار خلص وكام مرة ساب المشوار */
        try {
          if (next.status === "done" && r.status !== "done") me.rideCount = (me.rideCount || 0) + 1;
          if (b.status === "released") me.releaseCount = (me.releaseCount || 0) + 1;
          await putDoc(env, "drivers", me.id, me);
        } catch (e) {}
        /* نظام الرصيد: رسم المشوار بيتخصم مرة واحدة بس لما يخلص */
        if (next.status === "done" && !r.feeTaken && ss.state !== "free") {
          next.fee = sc.fee; next.feeTaken = true;
          const fresh = (await getDoc(env, "drivers", me.id)) || me;
          fresh.credit = +((+(fresh.credit || 0)) - sc.fee).toFixed(2);
          fresh.creditUsed = +((+(fresh.creditUsed || 0)) + sc.fee).toFixed(2);
          await putDoc(env, "drivers", me.id, fresh);
          /* نفس الرسم من رصيد الراكب (صاحب الحساب اللي طلب) — مش بيتضاف على الأجرة */
          if (r.source === "app") {
            const rk = riderKey(r.bookerPhone || r.riderPhone);
            if (rk.length >= 9) {
              const rd = (await getDoc(env, "riders", rk)) || { id: rk, phone: r.bookerPhone || r.riderPhone, name: r.riderName };
              rd.credit = +((+(rd.credit || 0)) - sc.fee).toFixed(2);
              rd.creditUsed = +((+(rd.creditUsed || 0)) + sc.fee).toFixed(2);
              await putDoc(env, "riders", rk, rd);
              next.riderFee = sc.fee;
            }
          }
        }
        await putDoc(env, "requests", rid, next);
        if (next.status === "done") { try { await pushFam(env, r.bookerPhone || r.riderPhone, { type: "done", requestId: r.id, to: r.to && r.to.label }, true); } catch (e) {} }
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

    if (route === "consents" && method === "GET") {
      const { consents } = await readDocs(env, ["consents"]);
      consents.sort((a, b) => (b.serverAt || 0) - (a.serverAt || 0));
      return json({ consents });
    }

    if (route === "state" && method === "GET") {
      const all = await readDocs(env, KINDS);
      const now = Date.now();
      try { await expireStale(env, all.requests || []); } catch (e) {}
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
