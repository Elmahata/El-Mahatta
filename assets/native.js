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
        return fetch("/api/push/register", { method: "POST", headers: h, body: JSON.stringify({ role: role, token: token, phone: me.phone || "", native: true }) }).then(function (r) { return r.ok; });
      }).catch(function () { return false; });
    },
    stop: function () {
      if (!P || !cur) return Promise.resolve();
      cur = "";
      return P.stop().catch(function () {});
    },
  };
})();
