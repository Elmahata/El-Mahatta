/**
 * Cloudflare Pages Function — API تطبيق «المحطة» — توكتوك كفر صقر
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
});

const rideCode = () => String(1000 + (crypto.getRandomValues(new Uint16Array(1))[0] % 9000));
const tokOk = (given, real) => Boolean(real) && safeEqual(given, real);

/** إنشاء طلب — مشترك بين تطبيق الراكب وطلبات التليفون من الإدارة */
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
  const fare = same ? cfg.same : cfg.cross;

  const id = uid(), tok = newToken(), share = newToken().slice(0, 12), now = Date.now();
  await putDoc(env, "requests", id, {
    id, token: tok, shareToken: share, code: rideCode(), source,
    riderName: name, riderPhone: phone, note: str(b.note, 140), from, to,
    fare, sameZone: same, status: "pending", driverId: "",
    createdAt: now, day: todayStr(),
  });
  return { ok: true, id, token: tok, shareToken: share, fare, sameZone: same };
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

    if (route === "request" && method === "POST") {
      const out = await createRequest(env, await parseBody(request), "app");
      return out.error ? json({ error: out.error }, out.status) : json(out);
    }

    /* متابعة الراكب — بيانات السائق تظهر فقط بعد ما يَقبل */
    if (route === "track" && sub && method === "GET") {
      const r = await getDoc(env, "requests", str(sub, 40));
      if (!r) return json({ error: "طلب غير موجود" }, 404);
      if (!r.token || !safeEqual(url.searchParams.get("token"), r.token))
        return json({ error: "غير مصرّح" }, 401);
      let driver = null;
      if (r.driverId && r.status === "assigned") {
        const d = await getDoc(env, "drivers", r.driverId);
        if (d) driver = { name: d.name, phone: d.phone, plate: d.plate };
      }
      return json({
        id: r.id, status: r.status, fare: r.fare, driver, createdAt: r.createdAt,
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
        if (d) driver = { name: d.name, plate: d.plate };
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
        const mine = mineFull ? (({ code, token, shareToken, ...rest }) => rest)(mineFull) : null;

        const blocked = ss.state === "stopped";

        /* السباق: كل الطلبات المفتوحة معروضة على كل سائق أونلاين بلا مرسال */
        const available = (me.online === false || mine || blocked) ? [] : requests
          .filter((r) => r.status === "pending" && now - (r.createdAt || 0) < CLAIM_WINDOW_MS)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          .slice(0, 20)
          .map(teaser);

        const done = requests.filter((r) => r.driverId === me.id && r.status === "done" && r.day === todayStr());
        return json({
          me: { id: me.id, name: me.name, plate: me.plate, online: me.online !== false },
          sub: { ...ss, week: sc.week, month: sc.month, grace: sc.grace },
          available, mine,
          today: { rides: done.length, earned: done.reduce((s, r) => s + (r.fare || 0), 0) },
        });
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

        /* القبول ذرّي: الشرط جوّه جملة UPDATE نفسها، فأول طلب يوصل للقاعدة هو الفائز */
        const next = { ...r, status: "assigned", driverId: me.id, assignedAt: Date.now() };
        const res = await env.DB.prepare(
          `UPDATE docs SET data=?, updated=?
           WHERE kind='requests' AND id=? AND json_extract(data,'$.status')='pending'`
        ).bind(JSON.stringify(next), Date.now(), rid).run();

        if (!res.meta || res.meta.changes !== 1) return json({ error: "سائق تاني خد المشوار" }, 409);
        return json({ ok: true, ride: next });
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
