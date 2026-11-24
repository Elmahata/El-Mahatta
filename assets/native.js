/* جسر التطبيق الأصلي (Capacitor): لو الصفحة مفتوحة جوه تطبيق المحطة الأصلي، بنشغّل خدمة المكان اللي بتفضل شغالة والشاشة مطفية.
   لو مفتوحة في Chrome عادي، الدوال دي مابتعملش حاجة. */
(function () {
  "use strict";
  var C = window.Capacitor, P = null;
  try {
    if (C && C.isNativePlatform && C.isNativePlatform()) P = C.registerPlugin ? C.registerPlugin("MahattaLocation") : (C.Plugins && C.Plugins.MahattaLocation);
  } catch (e) { P = null; }
  var PN = null;
  try { if (P) PN = C.registerPlugin ? C.registerPlugin("PushNotifications") : (C.Plugins && C.Plugins.PushNotifications); } catch (e) { PN = null; }
  /* نفس سلوك Chrome جوه التطبيق الأصلي: قايمة المشاركة + الاهتزاز */
  try {
    var SH = P && (C.registerPlugin ? C.registerPlugin("Share") : C.Plugins && C.Plugins.Share);
    if (SH && !navigator.share) navigator.share = function (d) { d = d || {}; return SH.share({ title: d.title || "", text: d.text || "", url: d.url || undefined, dialogTitle: "شارك" }).then(function () {}); };
    var HP = P && (C.registerPlugin ? C.registerPlugin("Haptics") : C.Plugins && C.Plugins.Haptics);
    if (HP) navigator.vibrate = function (p) { var ms = Array.isArray(p) ? p.reduce(function (s, v, i) { return i % 2 ? s : s + (+v || 0); }, 0) : +p || 0; if (ms > 0) HP.vibrate({ duration: Math.min(ms, 3000) }).catch(function () {}); return true; };
  } catch (e) {}
  /* النغمات بالكود الأصلي: بتشتغل على طول وفي وقتها (نفس النغمات بالظبط — ملفات res/raw) */
  var NT = { tap:1, ok:1, confirm:1, accepted:1, offer:1, picked:1, arrived:1, done:1, msg:1, waitbell:1, error:1, cancel:1, intro:1, search:1, dailysoon:1, newreq:1, coins:1, coins5:1 };
  if (P) (function patch(n) {
    var T = window.TT;
    if (!T || !T.sound) { if (n < 80) setTimeout(function () { patch(n + 1); }, 50); return; }
    if (T.sound.__native) return;
    var web = T.sound;
    T.sound = function (name) {
      if (T.soundOn && !T.soundOn()) return;
      var k = String(name || "").toLowerCase();
      if (!NT[k] || !P.tone) return web(name);
      P.tone({ name: k }).then(function (r) { if (!r || r.ok === false) web(name); }).catch(function () { web(name); });
    };
    T.sound.__native = true;
  })(0);
  /* لينكات المحطة اللي بتفتح التطبيق (تابع رحلتي/التحميل/السائق) ← نفتح الصفحة المطلوبة جوه التطبيق */
  try {
    var AP = P && (C.registerPlugin ? C.registerPlugin("App") : C.Plugins && C.Plugins.App);
    var goUrl = function (u) {
      try { var t = new URL(u); if (t.host !== location.host) return; var here = location.pathname + location.search; if (t.pathname + t.search !== here) location.href = t.pathname + t.search + t.hash; } catch (e) {}
    };
    if (AP) {
      AP.addListener("appUrlOpen", function (e) { if (e && e.url) goUrl(e.url); });
      if (!sessionStorage.getItem("mh-launch")) { sessionStorage.setItem("mh-launch", "1"); AP.getLaunchUrl().then(function (r) { if (r && r.url) goUrl(r.url); }).catch(function () {}); }
    }
  } catch (e) {}
  /* النت فصل/رجع (من الكود الأصلي — في نفس اللحظة) ← شريط «النت فاصل» فوق */
  var netOn = true;
  function netBar(on) {
    netOn = on;
    var b = document.getElementById("mhNetBar");
    if (on) { if (b) { b.style.transform = "translateY(-110%)"; setTimeout(function () { if (netOn && b.parentNode) b.parentNode.removeChild(b); }, 260); } }
    else if (!b) {
      b = document.createElement("div"); b.id = "mhNetBar"; b.setAttribute("role", "status");
      b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:7000;padding:calc(env(safe-area-inset-top,0px) + 8px) 14px 8px;background:var(--warn,#C98A1B);color:#1A1204;font:700 13.5px var(--body,'IBM Plex Sans Arabic',sans-serif);text-align:center;transform:translateY(-110%);transition:transform .25s ease";
      b.textContent = "النت فاصل — أي حاجة هتدوسها هتتبعت أول ما يرجع";
      (document.body || document.documentElement).appendChild(b);
      requestAnimationFrame(function () { b.style.transform = "translateY(0)"; });
    }
    try { window.dispatchEvent(new Event(on ? "online" : "offline")); } catch (e) {}
  }
  if (P && P.addListener) {
    P.addListener("net", function (e) { if (e && typeof e.online === "boolean" && e.online !== netOn) netBar(e.online); });
    if (P.netState) P.netState().then(function (r) { if (r && r.online === false) netBar(false); }).catch(function () {});
  }
  /* الراكب داس «استغاثة» من الإشعار والتطبيق مقفول ← الصفحة تكمّل الاستغاثة (من غير ما تبعتها تاني) */
  if (P && P.takeSos) setTimeout(function chk(n) {
    n = n || 0;
    if (typeof window.__mhSosStart !== "function") { if (n < 40) setTimeout(function () { chk(n + 1); }, 150); return; }
    P.takeSos().then(function (s) { if (s && s.id) window.__mhSosStart({ id: s.id, token: s.token }); }).catch(function () {});
  }, 300);
  var cur = "", pushTok = null, pushWait = null, wired = false;
  function wire() {
    if (wired || !PN) return; wired = true;
    /* قنوات الإشعارات — كل قناة بنغمة من نغمات التطبيق نفسها (ملفات في res/raw) */
    [["mh-alerts", "تنبيهات المحطة", "confirm"], ["mh-req", "طلبات جديدة", "newreq"], ["mh-ride", "الرحلة", "accepted"], ["mh-arrive", "وصول السائق", "arrived"], ["mh-sos", "الأمان", "cancel"], ["mh-daily", "المشوار اليومي", "dailysoon"], ["mh-msg", "الرسايل", "msg"]].forEach(function (c) {
      try { PN.createChannel({ id: c[0], name: c[1], importance: 5, visibility: 1, vibration: true, lights: true, sound: c[2] }).catch(function () {}); } catch (e) {}
    });
    PN.addListener("registration", function (t) { pushTok = t && t.value; if (pushWait) { pushWait(pushTok); pushWait = null; } });
    PN.addListener("registrationError", function () { if (pushWait) { pushWait(null); pushWait = null; } });
    /* التطبيق مفتوح: الصفحة بتتحدّث لوحدها، فبنكتفي بتنبيه صغير */
    PN.addListener("pushNotificationReceived", function (n) { try { if (window.TT && TT.toast && n && n.title) TT.toast(n.title); } catch (e) {} });
    /* دوس على الإشعار: افتح الصفحة المطلوبة */
    PN.addListener("pushNotificationActionPerformed", function (a) { try { var u = a && a.notification && a.notification.data && a.notification.data.url; if (u && u.charAt(0) === "/" && u !== location.pathname) location.href = u; } catch (e) {} });
  }
  /* تجهيز للتحويل لـ Kotlin الكامل: بنسخ بيانات الدخول (tt-* و mh-*) للتخزين الأصلي، فالتطبيق الجديد يقراها من غير ما يطلب تسجيل دخول تاني */
  function mirror() {
    if (!P || !P.prefsSet) return;
    try {
      var v = {};
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (/^(tt-|mh-)/.test(k)) { var x = localStorage.getItem(k); if (x != null && x.length < 4000) v[k] = x; } }
      P.prefsSet({ values: v }).catch(function () {});
    } catch (e) {}
  }
  /* آيفون الأهل: توكن «ابدأ الكارت» ← السيرفر يظهر كارت رحلة قريبك على شاشة القفل لوحده */
  if (P && P.laStartToken) setTimeout(function laS() {
    P.laStartToken().then(function (r) {
      var la = r && r.la, me = {}; try { me = JSON.parse(localStorage.getItem("tt-me") || "{}"); } catch (e) {}
      if (!la || !me.phone || !window.TT || !TT.api || localStorage.getItem("mh-la-start") === la) return;
      TT.api("la-start", { method: "POST", verify: { phone: me.phone, role: "rider" }, body: { phone: me.phone, la: la } }).then(function () { localStorage.setItem("mh-la-start", la); }).catch(function () {});
    }).catch(function () {});
  }, 5000);
  if (P) { setTimeout(mirror, 1500); setInterval(mirror, 15000); document.addEventListener("visibilitychange", function () { if (document.hidden) mirror(); }); }
  window.TTNative = {
    on: Boolean(P),
    push: Boolean(PN),
    /* o = { url, headers, extra, intervalMs, title, text } — key يمنع إعادة التشغيل كل نبضة */
    start: function (o, key) {
      if (!P) return Promise.resolve(false);
      if (key && key === cur) return Promise.resolve(true);
      cur = key || String(Date.now());
      return P.start(o).then(function () { return true; }).catch(function () { cur = ""; return false; });
    },
    /* إشعارات Firebase الأصلية: بتوصل والتطبيق مقفول خالص */
    pushInit: function (role, headersFn) {
      if (!PN) return Promise.resolve(false);
      wire();
      return PN.requestPermissions().then(function (r) {
        if (!r || r.receive !== "granted") return null;
        if (pushTok) return pushTok;
        return new Promise(function (ok) { pushWait = ok; PN.register().catch(function () { ok(null); }); setTimeout(function () { ok(pushTok); }, 15000); });
      }).then(function (token) {
        if (!token) return false;
        var h = Object.assign({ "content-type": "application/json" }, headersFn ? headersFn() : {});
        var me = {}; try { me = JSON.parse(localStorage.getItem("tt-me") || "{}"); } catch (e) {}
        return fetch("/api/push/register", { method: "POST", headers: h, body: JSON.stringify({ role: role, token: token, phone: me.phone || "", native: true, platform: (C.getPlatform && C.getPlatform()) || "android" }) }).then(function (r) { return r.ok; });
      }).catch(function () { return false; });
    },
    /* «البطارية بدون قيود» (شاومي/أوبو/…) */
    battery: function () { return P && P.battery ? P.battery().catch(function () { return { unrestricted: true }; }) : Promise.resolve({ unrestricted: true }); },
    openBattery: function () { return P && P.openBattery ? P.openBattery().catch(function () {}) : Promise.resolve(); },
    /* «طلب جديد» شاشة كاملة فوق القفل (أندرويد ١٤+ ممكن يحتاج إذن) */
    fullScreen: function () { return P && P.fullScreen ? P.fullScreen().catch(function () { return { allowed: true }; }) : Promise.resolve({ allowed: true }); },
    openFullScreen: function () { return P && P.openFullScreen ? P.openFullScreen().catch(function () {}) : Promise.resolve(); },
    /* التطبيق اتفتح من «طلب جديد» على الشاشة المقفولة؟ */
    takeLaunch: function () { return P && P.takeLaunch ? P.takeLaunch().catch(function () { return {}; }) : Promise.resolve({}); },
    /* إشعار الرحلة اللايف للراكب (زي أوبر) — بيتحدّث مع كل متابعة */
    rideLive: function (j, lv) {
      if (!P || !P.rideLive) return;
      var st = j && j.status;
      if (!j || st === "done" || st === "cancelled") return P.rideLive({ off: true }).catch(function () {});
      /* زرار «🆘 استغاثة» على الإشعار: بيبعت نفس طلب الاستغاثة اللي في الصفحة */
      var sos = null;
      try {
        var me = JSON.parse(localStorage.getItem("tt-me") || "{}"), tok = lv && lv.token;
        if (st === "assigned" && tok && me.phone) sos = { url: location.origin + "/api/family/sos", locUrl: location.origin + "/api/family/sos-loc",
          headers: window.TT && TT.sessionToken ? { "x-session": TT.sessionToken("rider") || "" } : {}, body: { phone: String(me.phone).replace(/\D/g, ""), requestId: j.id, token: tok } };
      } catch (e) {}
      var o = { origin: location.origin, ride: { id: j.id, status: st, shareToken: j.shareToken || "", driver: j.driver ? { name: j.driver.name || "", plate: j.driver.plate || "" } : null, driverLoc: j.driverLoc || null, from: j.from || null, to: j.to || null, arrivedAt: j.arrivedAt || null, startedAt: j.startedAt || null } };
      if (sos) o.sos = sos;
      /* آيفون: توكن الرحلة علشان كارت شاشة القفل (Live Activity) يتحدّث من السيرفر */
      if (lv && lv.token) o.tok = lv.token;
      P.rideLive(o).catch(function () {});
    },
    /* السائق: المشوار الحالي ← زراير «وصلت» و«جوجل ماب» على الإشعار الثابت */
    driverRide: function (r) {
      if (!P || !P.driverRide) return;
      if (!r) return P.driverRide({}).catch(function () {});
      var g = r.startedAt ? r.to : r.from;
      var o = { rid: r.id, started: Boolean(r.startedAt), arrived: Boolean(r.arrivedAt), base: location.origin };
      if (g && isFinite(+g.lat) && isFinite(+g.lng)) { o.lat = +g.lat; o.lng = +g.lng; }
      P.driverRide(o).catch(function () {});
    },
    /* أمر اتداس والنت فاصل ← بيتحفظ ويتبعت لوحده أول ما النت يرجع */
    queue: function (url, headers, body) { return P && P.queue ? P.queue({ url: url, headers: headers || {}, body: body || {} }).then(function () { return true; }).catch(function () { return false; }) : Promise.resolve(false); },
    online: function () { return netOn; },
    /* حذف الحساب: الآيفون بيمسح التوكنات والكروت والأوامر المستنية (أندرويد: مفيش حاجة) */
    reset: function () { return P && P.reset ? P.reset().catch(function () {}) : Promise.resolve(); },
    /* الراكب قفل الاستغاثة: أي استغاثة لسه مستنية النت تتلغي */
    sosOff: function (id) { return P && P.sosOff ? P.sosOff({ requestId: String(id || "") }).catch(function () {}) : Promise.resolve(); },
    ios: Boolean(P && C.getPlatform && C.getPlatform() === "ios"),
    /* Widget الآيفون: آخر مكانين الراكب راحهم */
    recent: function (pt) {
      try {
        var a = JSON.parse(localStorage.getItem("mh-recent") || "[]").filter(function (x) { return x.l !== pt.label; });
        a.unshift({ l: String(pt.label).slice(0, 40), lat: +(+pt.lat).toFixed(5), lng: +(+pt.lng).toFixed(5) });
        a = a.slice(0, 2); localStorage.setItem("mh-recent", JSON.stringify(a));
        if (P && P.widgetData) P.widgetData({ items: a }).catch(function () {});
      } catch (e) {}
    },
    /* Face ID لـ «حسابي» و«أهلي» */
    bio: function (reason) { return P && P.bio ? P.bio({ reason: reason || "افتح حسابك في المحطة" }).catch(function () { return { ok: false }; }) : Promise.resolve({ ok: true }); },
    /* «افتح في جوجل ماب» بالملاحة */
    openMaps: function (lat, lng) {
      var web = function () { window.open("https://www.google.com/maps/dir/?api=1&destination=" + lat + "," + lng + "&travelmode=driving", "_blank"); };
      if (!P || !P.openMaps) return web();
      P.openMaps({ lat: +lat, lng: +lng }).catch(web);
    },
    stop: function () {
      if (!P || !cur) return Promise.resolve();
      cur = "";
      return P.stop().catch(function () {});
    },
  };
})();
