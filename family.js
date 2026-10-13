/* أهلي: ربط الأهل + التنبيهات (ركب / وصل / طوارئ). بيشتغل في صفحة الراكب وصفحة «حسابي». */
(function () {
  if (!window.TT) return;
  var T = window.TT;
  function me() { try { return JSON.parse(localStorage.getItem("tt-me") || "{}"); } catch (e) { return {}; } }
  function phone() { return (me().phone || "").replace(/\D/g, ""); }
  function call(path, opts) {
    opts = opts || {};
    var p = phone(); if (!p) return Promise.reject(new Error("اكتب رقمك في البروفايل الأول"));
    if (opts.method === "POST") opts.body = Object.assign({ phone: p }, opts.body || {});
    else path += (path.indexOf("?") < 0 ? "?" : "&") + "phone=" + encodeURIComponent(p);
    if (T.verify && T.hasSession && T.hasSession("rider")) opts.verify = { phone: p, role: "rider" };
    return T.api(path, opts);
  }
  T.family = { call: call };

  /* ---------- الإنذار ---------- */
  var actx = null, siren = null;
  function startSiren() {
    try {
      var A = window.AudioContext || window.webkitAudioContext; actx = actx || new A();
      var o = actx.createOscillator(), g = actx.createGain(), lfo = actx.createOscillator(), lg = actx.createGain();
      o.type = "sawtooth"; o.frequency.value = 760; lfo.frequency.value = 1.6; lg.gain.value = 260;
      lfo.connect(lg); lg.connect(o.frequency);
      g.gain.setValueAtTime(0.0001, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.35, actx.currentTime + 4);
      o.connect(g); g.connect(actx.destination); o.start(); lfo.start();
      siren = { o: o, lfo: lfo };
    } catch (e) {}
    try { navigator.vibrate && navigator.vibrate([700, 300, 700, 300, 700, 300, 700, 300, 700, 300, 700]); } catch (e) {}
  }
  function stopSiren() {
    try { if (siren) { siren.o.stop(); siren.lfo.stop(); } } catch (e) {}
    siren = null; try { navigator.vibrate && navigator.vibrate(0); } catch (e) {}
  }
  function chime() {
    try {
      var A = window.AudioContext || window.webkitAudioContext; actx = actx || new A(); var t = actx.currentTime;
      [0, .18].forEach(function (d, i) { var o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = i ? 990 : 740;
        g.gain.setValueAtTime(.0001, t + d); g.gain.exponentialRampToValueAtTime(.25, t + d + .02); g.gain.exponentialRampToValueAtTime(.0001, t + d + .25);
        o.connect(g); g.connect(actx.destination); o.start(t + d); o.stop(t + d + .27); });
      navigator.vibrate && navigator.vibrate([90, 60, 90]);
    } catch (e) {}
  }
  function sysNote(title, body, tag, urgent) {
    if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted" || !navigator.serviceWorker) return;
    navigator.serviceWorker.ready.then(function (reg) {
      reg.showNotification(title, { body: body, tag: tag, renotify: true, requireInteraction: !!urgent, vibrate: urgent ? [700, 300, 700, 300, 700] : [90, 60, 90], icon: "/assets/icon-192.png", badge: "/assets/icon-192.png", data: { url: "/" } });
    }).catch(function () {});
  }
  function trackUrl(a) { return a.share ? location.origin + "/track.html?id=" + encodeURIComponent(a.requestId) + "&s=" + encodeURIComponent(a.share) : ""; }

  function showSOS(a) {
    var url = trackUrl(a), name = a.riderName || "قريبك";
    var map = a.loc ? "https://maps.google.com/?q=" + a.loc.lat + "," + a.loc.lng : "";
    var ov = document.createElement("div"); ov.className = "fam-sos";
    ov.innerHTML = '<div class="fam-sos-in">'
      + '<div class="fam-sos-ic">⚠</div>'
      + '<h2>' + T.esc(name) + ' داس طوارئ</h2>'
      + '<p>' + (a.driver ? "في توكتوك مع " + T.esc(a.driver) + "<br>" : "") + new Date(a.at).toLocaleTimeString("ar-EG", { hour: "numeric", minute: "2-digit" }) + '</p>'
      + (url ? '<a class="btn btn-wide fam-b1" href="' + url + '" target="_blank" rel="noopener">شوف مكانه لايف</a>' : (map ? '<a class="btn btn-wide fam-b1" href="' + map + '" target="_blank" rel="noopener">مكانه على الخريطة</a>' : ''))
      + (a.riderPhone ? '<a class="btn btn-wide fam-b2" href="tel:' + T.esc(a.riderPhone) + '">اتصل بـ' + T.esc(name) + '</a>' : '')
      + '<a class="btn btn-wide fam-b2" href="tel:122">اتصل بالنجدة ١٢٢</a>'
      + '<button class="btn btn-wide fam-b3" type="button" id="famSeen">شفته — اقفل الإنذار</button></div>';
    document.body.appendChild(ov);
    startSiren();
    sysNote("⚠ " + name + " داس طوارئ", (a.driver ? "مع " + a.driver + " — " : "") + "افتح التطبيق دلوقتي", "sos-" + a.id, true);
    ov.querySelector("#famSeen").addEventListener("click", function () { stopSiren(); ov.remove(); });
    ov.querySelectorAll("a").forEach(function (x) { x.addEventListener("click", stopSiren); });
  }
  function showInfo(a) {
    var url = trackUrl(a), name = a.riderName || "قريبك";
    var title = a.type === "start" ? name + " ركب توكتوك" : name + " وصل بالسلامة ✓";
    var body = a.type === "start" ? (a.driver ? "مع " + a.driver : "") + (a.to ? " · رايح " + a.to : "") : (a.to ? "وصل " + a.to : "");
    chime(); sysNote(title, body, "fam-" + a.requestId + "-" + a.type, false);
    var el = document.createElement("div"); el.className = "fam-card " + (a.type === "start" ? "go" : "ok");
    el.innerHTML = '<div style="flex:1;min-width:0"><b>' + T.esc(title) + '</b><div class="hint" style="color:inherit;opacity:.85">' + T.esc(body) + '</div></div>'
      + (url && a.type === "start" ? '<a class="btn btn-sm" href="' + url + '" target="_blank" rel="noopener" style="background:#fff;color:#0A5A4E">تابع</a>' : '')
      + '<button type="button" aria-label="اقفل" style="background:none;border:0;color:inherit;font-size:20px;min-width:36px;min-height:36px">×</button>';
    document.body.appendChild(el);
    var close = function () { el.classList.add("out"); setTimeout(function () { el.remove(); }, 300); };
    el.querySelector("button").addEventListener("click", close);
    setTimeout(close, a.type === "start" ? 12000 : 7000);
  }
  function showInvite(n) {
    if (document.getElementById("famInv") || /me\.html/.test(location.pathname)) return;
    var el = document.createElement("a"); el.id = "famInv"; el.href = "/me.html#family"; el.className = "fam-card go";
    el.innerHTML = '<div style="flex:1"><b>حد عايز يضيفك من أهله</b><div class="hint" style="color:inherit;opacity:.85">دوس علشان توافق أو ترفض</div></div><span class="chip" style="background:#fff;color:#0A5A4E">' + n + '</span>';
    document.body.appendChild(el);
  }

  /* ---------- الاستقبال: كل ٨ ثواني والصفحة مفتوحة، وكل ٢٠ في الخلفية ---------- */
  var KEY = "tt-fam-since", timer = null;
  function since() { return +(localStorage.getItem(KEY) || 0) || (Date.now() - 10 * 6e4); }
  function poll() {
    clearTimeout(timer); timer = setTimeout(poll, document.hidden ? 20000 : 8000);
    if (!phone()) return;
    call("family/alerts?since=" + since(), { retry: false }).then(function (j) {
      if (+j.invites > 0) showInvite(+j.invites);
      var top = since();
      (j.items || []).forEach(function (a) { if (a.at > top) top = a.at; if (a.type === "sos") showSOS(a); else showInfo(a); });
      try { localStorage.setItem(KEY, String(top)); } catch (e) {}
    }).catch(function () {});
  }
  if (!localStorage.getItem(KEY)) try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {}
  setTimeout(poll, 2500);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
})();
