/* إشعارات وهو التطبيق مقفول (Firebase Cloud Messaging).
   TT.push.init(role, headersFn): بيطلب الإذن لو لسه، وبياخد توكن الموبايل، وبيبعته للسيرفر. */
(function () {
  var V = "10.12.2", loading = null, done = {};
  function load(src) {
    return new Promise(function (ok, no) { var s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  }
  function sdk() {
    if (window.firebase && firebase.messaging) return Promise.resolve();
    loading = loading || load("https://www.gstatic.com/firebasejs/" + V + "/firebase-app-compat.js")
      .then(function () { return load("https://www.gstatic.com/firebasejs/" + V + "/firebase-messaging-compat.js"); });
    return loading;
  }
  /* جوه التطبيق الأصلي: الإشعارات الأصلية (assets/native.js) بدل إشعارات المتصفح */
  function isNative() { try { return Boolean(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()); } catch (e) { return false; } }
  function ready() { if (isNative()) return true; var c = window.MH_FCM; return Boolean(c && c.config && c.vapid && "serviceWorker" in navigator && "Notification" in window); }

  window.TT = window.TT || {};
  TT.push = {
    ready: ready,
    init: function (role, headersFn) {
      if (!ready() || done[role]) return Promise.resolve(false);
      if (isNative()) return (window.TTNative && TTNative.pushInit ? TTNative.pushInit(role, headersFn) : Promise.resolve(false)).then(function (ok) { if (ok) done[role] = true; return ok; });
      var ask = Notification.permission === "default" ? Notification.requestPermission() : Promise.resolve(Notification.permission);
      return ask.then(function (p) {
        if (p !== "granted") return false;
        return sdk().then(function () {
          if (!firebase.apps.length) firebase.initializeApp(MH_FCM.config);
          return navigator.serviceWorker.ready;
        }).then(function (reg) {
          return firebase.messaging().getToken({ vapidKey: MH_FCM.vapid, serviceWorkerRegistration: reg });
        }).then(function (token) {
          if (!token) return false;
          var h = Object.assign({ "content-type": "application/json" }, headersFn ? headersFn() : {});
          var me = {}; try { me = JSON.parse(localStorage.getItem("tt-me") || "{}"); } catch (e) {}
          return fetch("/api/push/register", { method: "POST", headers: h, body: JSON.stringify({ role: role, token: token, phone: me.phone || "" }) })
            .then(function (r) { if (r.ok) done[role] = true; return r.ok; });
        });
      }).catch(function () { return false; });
    }
  };

  /* لو الراكب مسجّل دخول بالفعل: سجّل على طول. الراكب الجديد بيتسأل عن الإشعارات أول ما يطلب مشوار (مش أول ما يفتح التطبيق) */
  if (ready() && (isNative() || Notification.permission === "granted")) {
    setTimeout(function () {
      var drv = /driver/.test(location.pathname);
      if (drv) { try { var a = JSON.parse(localStorage.getItem("tt-driver") || "null"); if (a && a.phone) TT.push.init("driver", function () { return { "x-driver-phone": a.phone, "x-driver-code": a.code, "x-driver-device": TT.devId() }; }); } catch (e) {} }
      else if ((TT.sessionToken && TT.sessionToken("rider")) || localStorage.getItem("tt-me")) TT.push.init("rider", function () { return TT.sessionToken ? { "x-session": TT.sessionToken("rider") } : {}; });
    }, 2500);
  }
})();
