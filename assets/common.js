/* أدوات مشتركة بين صفحة الراكب وصفحة الإدارة */
(function (global) {
  "use strict";

  var ZC = ["#0E7566", "#BC4E1E", "#3F6DA8", "#8A5A9E", "#6E8B2E", "#B08A17", "#A9382B", "#4E7D74", "#2F7F8C", "#96602A"];

  /* مركز افتراضي للخريطة — بتروح لمكان الراكب أو الأماكن المسجّلة تلقائياً */
  var CENTER = [30.7964, 31.6261];
  /* الموبايلات الضعيفة أو «توفير البيانات»: الحركة بتخف لوحدها */
  try {
    var nv = navigator, cn = nv.connection || {};
    if ((nv.deviceMemory && nv.deviceMemory <= 2) || (nv.hardwareConcurrency && nv.hardwareConcurrency <= 2) || cn.saveData) document.documentElement.classList.add("lite");
  } catch (e) {}

  var T = {
    $: function (id) { return document.getElementById(id); },

    esc: function (s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
      });
    },

    uid: function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); },

    today: function () { return new Date().toISOString().slice(0, 10); },

    daysTo: function (d) {
      if (!d) return null;
      return Math.round((new Date(d + "T00:00:00") - new Date(T.today() + "T00:00:00")) / 864e5);
    },

    timeAgo: function (ts) {
      if (!ts) return "";
      var m = Math.max(0, Math.round((Date.now() - ts) / 6e4));
      if (m < 1) return "الآن";
      if (m < 60) return "من " + m + " د";
      return "من " + Math.round(m / 60) + " س";
    },

    /* رقم مصري إلى صيغة واتساب الدولية */
    waNum: function (p) {
      var d = String(p || "").replace(/\D/g, "");
      if (d.indexOf("0") === 0) d = "20" + d.slice(1);
      else if (d.indexOf("20") !== 0 && d.length === 10) d = "20" + d;
      return d;
    },

    byId: function (arr, id) {
      for (var i = 0; i < (arr || []).length; i++) if (arr[i].id === id) return arr[i];
      return null;
    },

    zoneColor: function (zones, zid) {
      for (var i = 0; i < (zones || []).length; i++) if (zones[i].id === zid) return ZC[i % ZC.length];
      return "#798782";
    },

    zoneName: function (zones, zid) {
      var z = T.byId(zones, zid);
      return z ? z.name : "بدون منطقة";
    },

    /* السعر يُعرض هنا للمستخدم؛ الخادم يعيد حسابه عند التأكيد ولا يثق بالعميل */
    fareFor: function (state, fromId, toId) {
      var a = T.byId(state.places, fromId), b = T.byId(state.places, toId);
      var cfg = state.cfg || { same: 15, cross: 20 };
      if (!a || !b) return { amount: cfg.cross, same: false, known: false };
      var same = Boolean(a.zoneId && b.zoneId && a.zoneId === b.zoneId);
      return { amount: same ? cfg.same : cfg.cross, same: same, known: Boolean(a.zoneId && b.zoneId) };
    },

    mapsUrl: function (from, to) {
      var sfx = "، مصر";
      var o = from ? (from.lat != null ? from.lat + "," + from.lng : from.name + sfx) : "";
      var d = to ? (to.lat != null ? to.lat + "," + to.lng : to.name + sfx) : "";
      return "https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=" +
        encodeURIComponent(o) + "&destination=" + encodeURIComponent(d);
    },

    toast: function (msg) {
      var el = document.createElement("div");
      el.className = "toast";
      el.setAttribute("role", "status");
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(function () { el.remove(); }, 2600);
    },

    /* ---------- الاتصال بالخادم ---------- */
    api: function (path, opts) {
      opts = opts || {};
      var headers = { "content-type": "application/json" };
      if (opts.pin) headers["x-pin"] = opts.pin;
      if (opts.verify && T.verify) {
        var v = opts.verify; delete opts.verify;
        return T.verify(v.phone, v.role).then(function (tok) { opts.session = tok; return T.api(path, opts); });
      }
      if (opts.session) headers["x-session"] = opts.session;
      /* النت الضعيف: لو الطلب ماوصلش خالص بنحاول تاني مرتين لوحدنا */
      var tries = opts.retry === false ? 0 : 2, method = opts.method || "GET";
      function send(n) {
        return fetch("/api/" + path, { method: method, headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
          .catch(function (e) {
            if (n >= tries) throw Object.assign(new Error("النت ضعيف أو مقطوع — اتأكد من الاتصال وجرّب تاني"), { network: true });
            if (method !== "GET" && T.toast) T.toast("النت ضعيف… بنحاول تاني");
            return new Promise(function (ok) { setTimeout(ok, 1500 * (n + 1)); }).then(function () { return send(n + 1); });
          });
      }
      return send(0).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) {
            if (j.reverify && T.clearSession) T.clearSession(j.reverify);
            throw Object.assign(new Error(j.error || "خطأ"), { status: r.status });
          }
          return j;
        });
      });
    },

    /* يحوّل رد الخادم إلى شكل الحالة المستخدم في الصفحات */
    shape: function (raw) {
      var cfgDoc = (raw.config || []).filter(function (c) { return c.id === "pricing"; })[0];
      return {
        zones: raw.zones || [],
        places: raw.places || [],
        drivers: raw.drivers || [],
        requests: raw.requests || [],
        cfg: {
          same: cfgDoc && cfgDoc.same != null ? cfgDoc.same : 15,
          cross: cfgDoc && cfgDoc.cross != null ? cfgDoc.cross : 20,
          sub: cfgDoc && cfgDoc.sub != null ? cfgDoc.sub : 200,
          freeUntil: (cfgDoc && cfgDoc.freeUntil) || "",
          paidFrom: (cfgDoc && cfgDoc.paidFrom) || "",
          week: cfgDoc && cfgDoc.week != null ? cfgDoc.week : 30,
          month: cfgDoc && cfgDoc.month != null ? cfgDoc.month : 100,
          grace: cfgDoc && cfgDoc.grace != null ? cfgDoc.grace : 3,
          creditOn: Boolean(cfgDoc && cfgDoc.creditOn), creditFrom: (cfgDoc && cfgDoc.creditFrom) || "",
          tripFee: cfgDoc && +cfgDoc.tripFee > 0 ? +cfgDoc.tripFee : 1,
          adminPhone: (cfgDoc && cfgDoc.adminPhone) || "",
        },
      };
    },

    /* ---------- الخريطة ---------- */
    CENTER: CENTER,

    initMap: function (elId) {
      var map = L.map(elId, { scrollWheelZoom: false }).setView(CENTER, 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      map.on("focus", function () { map.scrollWheelZoom.enable(); });
      map.on("blur", function () { map.scrollWheelZoom.disable(); });
      return map;
    },

    markerIcon: function (color, big) {
      var s = big ? 20 : 13;
      return L.divIcon({
        className: "", iconSize: [s, s], iconAnchor: [s / 2, s / 2],
        html: '<div class="mk" style="width:' + s + 'px;height:' + s + 'px;background:' + color + '"></div>',
      });
    },

    /**
     * يرسم النقاط والمسار على الخريطة.
     * ترجع عدد النقاط التي لها إحداثيات.
     */
    drawTrip: function (ctx) {
      var map = ctx.map, state = ctx.state;
      var from = T.byId(state.places, ctx.fromId), to = T.byId(state.places, ctx.toId);

      (ctx.layers || []).forEach(function (l) { map.removeLayer(l); });
      ctx.layers = [];

      var placed = state.places.filter(function (p) { return p.lat != null && p.lng != null; });
      placed.forEach(function (p) {
        var on = (from && p.id === from.id) || (to && p.id === to.id);
        var m = L.marker([p.lat, p.lng], {
          icon: T.markerIcon(T.zoneColor(state.zones, p.zoneId), on),
          title: p.name,
          opacity: on ? 1 : 0.8,
          keyboard: false,
        }).addTo(map);
        m.bindTooltip(p.name, { direction: "top", offset: [0, -9] });
        if (ctx.onPick) m.on("click", function () { ctx.onPick(p.id); });
        ctx.layers.push(m);
      });

      var a = from && from.lat != null ? from : null;
      var b = to && to.lat != null ? to : null;
      if (a && b && a !== b) {
        var f = T.fareFor(state, ctx.fromId, ctx.toId);
        var line = L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
          color: f.same ? "#0E7566" : "#BC4E1E", weight: 4, opacity: 0.9,
        }).addTo(map);
        ctx.layers.push(line);
        var mid = L.marker([(a.lat + b.lat) / 2, (a.lng + b.lng) / 2], {
          interactive: false,
          icon: L.divIcon({
            className: "", iconSize: [54, 22], iconAnchor: [27, 11],
            html: '<div style="background:#fff;color:' + (f.same ? "#0E7566" : "#BC4E1E") +
              ';border:1.5px solid currentColor;border-radius:11px;text-align:center;font:700 12px/20px system-ui">' +
              f.amount + ' ج</div>',
          }),
        }).addTo(map);
        ctx.layers.push(mid);
        map.fitBounds(line.getBounds(), { padding: [42, 42], maxZoom: 17 });
      } else if (placed.length) {
        map.fitBounds(L.latLngBounds(placed.map(function (p) { return [p.lat, p.lng]; })), { padding: [34, 34], maxZoom: 16 });
      }
      return placed.length;
    },
  };

  /* ---------- المسار على الطرق (OSRM — مجاني) + المسافة ---------- */
  T.dist = function (a, b) {
    var R = 6371, toR = Math.PI / 180, dLa = (b.lat - a.lat) * toR, dLo = (b.lng - a.lng) * toR;
    var x = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  };
  var RC = {};
  /* بيرجّع { coords:[[lat,lng]…], km, min, road } — لو الخدمة وقعت بيرجّع خط مستقيم */
  T.route = function (a, b) {
    var k = [a.lat, a.lng, b.lat, b.lng].map(function (x) { return (+x).toFixed(4); }).join(",");
    if (RC[k]) return RC[k];
    var km = T.dist(a, b) * 1.3;
    var straight = { coords: [[a.lat, a.lng], [b.lat, b.lng]], km: km, min: Math.max(1, Math.round(km / 15 * 60)), road: false };
    RC[k] = fetch("https://router.project-osrm.org/route/v1/driving/" + a.lng + "," + a.lat + ";" + b.lng + "," + b.lat + "?overview=full&geometries=geojson")
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var rt = j && j.routes && j.routes[0]; if (!rt) throw new Error("no route");
        /* التوكتوك أبطأ من العربية — ×١.٤ على الوقت */
        var out = { coords: rt.geometry.coordinates.map(function (p) { return [p[1], p[0]]; }), km: rt.distance / 1000, min: Math.max(1, Math.round(rt.duration / 60 * 1.4)), road: true };
        /* لفّة مش منطقية (أطول من ٣ أضعاف الخط المستقيم) = غالباً نقطة متحددة غلط أو كوبري مشاه — نرجع للتقدير */
        if (out.km > Math.max(8, km * 3)) { straight.odd = true; return straight; }
        return out;
      })
      .catch(function () { delete RC[k]; return straight; });
    return RC[k];
  };
  /* اسم الشارع من الخريطة (مجاني — OpenStreetMap). بيرجّع "" لو مفيش */
  var GC = {};
  T.reverse = function (lat, lng) {
    var k = (+lat).toFixed(4) + "," + (+lng).toFixed(4);
    if (GC[k]) return GC[k];
    GC[k] = fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=ar&zoom=18&lat=" + lat + "&lon=" + lng)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var a = (j && j.address) || {};
        var near = j && j.name && j.name !== a.road ? j.name : "";
        var road = a.road || a.pedestrian || a.footway || "";
        var area = a.neighbourhood || a.suburb || a.village || a.town || a.city || "";
        return [near, road, area].filter(Boolean).filter(function (v, i, s) { return s.indexOf(v) === i; }).slice(0, 2).join("، ");
      })
      .catch(function () { delete GC[k]; return ""; });
    return GC[k];
  };
  /* بيدوّر على اسم مكان جوه حدود المدينة بس (~٦ كم) — بيرجّع {lat,lng,label} أو null */
  T.geocode = function (name, center) {
    center = center || CENTER;
    var d = 0.06, vb = [center[1] - d, center[0] + d, center[1] + d, center[0] - d].join(",");
    var base = "https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=ar&limit=1&bounded=1&viewbox=" + vb + "&q=";
    var short = String(name).replace(/\s*(كفر صقر|\(.*?\))\s*/g, " ").trim();
    function q(s) { return fetch(base + encodeURIComponent(s)).then(function (r) { return r.json(); }).then(function (j) { return j && j[0] ? { lat: +(+j[0].lat).toFixed(6), lng: +(+j[0].lon).toFixed(6), label: j[0].display_name } : null; }); }
    return q(name).then(function (r) { return r || (short && short !== name ? new Promise(function (ok) { setTimeout(ok, 1100); }).then(function () { return q(short); }) : null); }).catch(function () { return null; });
  };
  /* أماكن حقيقية ليها اسم في حدود ~٤ كم من المركز (للإدارة — مرة واحدة) */
  T.nearbyPOIs = function (center) {
    var q = '[out:json][timeout:25];(nwr["name"]["amenity"](around:4000,' + center[0] + ',' + center[1] + ');nwr["name"]["railway"="station"](around:4000,' + center[0] + ',' + center[1] + ');nwr["name"]["healthcare"](around:4000,' + center[0] + ',' + center[1] + ');nwr["name"]["office"="government"](around:4000,' + center[0] + ',' + center[1] + '););out center 200;';
    return fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var seen = {};
        return (j.elements || []).map(function (e) {
          var t = e.tags || {};
          return { name: t["name:ar"] || t.name, kind: t.amenity || t.healthcare || t.office || t.railway || "", lat: e.lat != null ? e.lat : e.center && e.center.lat, lng: e.lon != null ? e.lon : e.center && e.center.lon };
        }).filter(function (p) { if (!p.name || p.lat == null || seen[p.name]) return false; seen[p.name] = 1; return true; });
      });
  };
  try { if (localStorage.getItem("tt-big") === "1") document.documentElement.style.fontSize = "118%"; } catch (e) {}
  /* ---------- أصوات التطبيق: نغمات قصيرة متولّدة (من غير ملفات) — تتقفل من «حسابي» ---------- */
  var SND = {
    tap:      [[880, 0, .06, "sine", .12]],
    confirm:  [[523, 0, .12], [659, .1, .12], [784, .2, .22]],
    accepted: [[587, 0, .14], [740, .12, .14], [880, .24, .14], [1175, .36, .34]],
    arrived:  [[660, 0, .18], [880, .22, .18], [1100, .44, .3]],
    done:     [[784, 0, .14], [988, .12, .14], [1319, .26, .42, "triangle"]],
    msg:      [[988, 0, .08], [1319, .09, .12]],
    error:    [[330, 0, .16, "square", .12], [247, .16, .26, "square", .12]],
    cancel:   [[659, 0, .16, "sine", .16], [523, .15, .16, "sine", .16], [415, .3, .5, "sine", .18]],
    /* نغمة الدخول «نطّة الدبوس»: الضربة التقيلة على ٠٫٥ ثانية = لحظة نزول اللوجو على الأرض */
    intro:    [[900, .05, .42, "sine", .05, 300], [110, .5, .3, "sine", .35, 70], [220, .5, .22, "triangle", .14], [523, .62, .55, "sine", .12], [659, .69, .55, "sine", .12], [784, .76, .55, "sine", .12], [1047, .83, .55, "sine", .12]],
    newReq:   [[880, 0, .16, "square"], [660, .2, .16, "square"], [880, .4, .26, "square"]],
  };
  var sctx = null;
  T.soundOn = function () { try { return localStorage.getItem("tt-sound") !== "off"; } catch (e) { return true; } };
  T.sound = function (name) {
    if (!T.soundOn() || !SND[name]) return;
    try {
      var A = global.AudioContext || global.webkitAudioContext; sctx = sctx || new A();
      if (sctx.state === "suspended") sctx.resume();
      var t = sctx.currentTime + .02;
      SND[name].forEach(function (n) {
        var o = sctx.createOscillator(), g = sctx.createGain(), vol = n[4] || .22;
        o.type = n[3] || "sine"; o.frequency.setValueAtTime(n[0], t + n[1]); if (n[5]) o.frequency.exponentialRampToValueAtTime(n[5], t + n[1] + n[2]);
        g.gain.setValueAtTime(.0001, t + n[1]); g.gain.exponentialRampToValueAtTime(vol, t + n[1] + .015); g.gain.exponentialRampToValueAtTime(.0001, t + n[1] + n[2]);
        o.connect(g); g.connect(sctx.destination); o.start(t + n[1]); o.stop(t + n[1] + n[2] + .02);
      });
    } catch (e) {}
  };
  /* صوت بيقرا الكلام بالعربي (لو الموبايل فيه صوت عربي) */
  T.say = function (text) {
    if (!T.soundOn() || !global.speechSynthesis) return;
    try {
      var u = new SpeechSynthesisUtterance(text), vs = speechSynthesis.getVoices();
      var v = vs.filter(function (x) { return /^ar[-_]EG/i.test(x.lang); })[0] || vs.filter(function (x) { return /^ar/i.test(x.lang); })[0];
      if (v) u.voice = v; u.lang = v ? v.lang : "ar-EG"; u.rate = .95;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch (e) {}
  };
  if (global.speechSynthesis) try { speechSynthesis.getVoices(); } catch (e) {}
  /* أول دوسة في الصفحة بتفتح الصوت (أندرويد بيمنع الصوت قبل أي دوسة) */
  document.addEventListener("pointerdown", function un() { try { var A = global.AudioContext || global.webkitAudioContext; sctx = sctx || new A(); sctx.resume(); } catch (e) {} document.removeEventListener("pointerdown", un, true); }, true);

  /* شارة ترتيب السائق: ذهبي / فضي / برونزي / جديد */
  var TIERS = { gold: ["ذهبي", "#8A6508", "#FFF3C4", "#F5C842"], silver: ["فضي", "#4A565D", "#EEF1F3", "#C0C8CE"], bronze: ["برونزي", "#7A4019", "#F6E3D3", "#CD7F32"], "new": ["سائق جديد", "#0A5A4E", "#D6EBE6", "#0E7566"] };
  T.tierBadge = function (d) {
    if (!d) return "";
    var t = TIERS[d.tier], stars = d.rating ? '<span class="num" style="font-weight:800;color:#8A6508">★ ' + d.rating + '</span><span style="opacity:.75">(' + d.ratingCount + ')</span>' : "";
    var medal = t ? '<span class="tier tier-' + d.tier + '" style="display:inline-flex;align-items:center;gap:5px;background:' + t[2] + ';color:' + t[1] + ';border-radius:999px;padding:2px 10px 2px 4px;font-weight:700;font-size:12.5px">'
      + '<span style="width:16px;height:16px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff 0%,' + t[3] + ' 45%,' + t[1] + ' 100%);box-shadow:0 0 0 1.5px ' + t[3] + '"></span>' + t[0] + '</span>' : "";
    return '<span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px">' + medal + stars + '</span>';
  };

  /* المسار المتحرك: حدّ أبيض + خط بيترسم + نقط ماشية فوقه في اتجاه المشوار */
  T.animRoute = function (map, coords, color) {
    var g = L.layerGroup().addTo(map);
    var casing = L.polyline(coords, { color: "#fff", weight: 9, opacity: .95, className: "mh-route-casing", interactive: false }).addTo(g);
    var main = L.polyline(coords, { color: color, weight: 5, opacity: 1, className: "mh-route", interactive: false }).addTo(g);
    var flow = L.polyline(coords, { color: "#fff", weight: 4, opacity: 1, lineCap: "round", className: "mh-route-flow", interactive: false }).addTo(g);
    function norm() { [casing, main].forEach(function (l) { var e = l.getElement && l.getElement(); if (e) e.setAttribute("pathLength", "1000"); }); }
    norm();
    g.setLatLngs = function (c2) { casing.setLatLngs(c2); main.setLatLngs(c2); flow.setLatLngs(c2); norm(); return g; };
    g.redraw = function () { var e = main.getElement(); if (!e) return; e.style.animation = "none"; void e.getBBox; e.getBoundingClientRect(); e.style.animation = ""; };
    g.getBounds = function () { return main.getBounds(); };
    g.setStyle = function (o) { main.setStyle(o); return g; };
    return g;
  };
  /* احتفال صغير: لما السائق يقبل (عند الراكب)، أو لما السائق ياخد المشوار */
  T.celebrate = function (o) {
    o = o || {};
    try { navigator.vibrate && navigator.vibrate([40, 60, 90]); } catch (e) {}
    if (!o.silent) T.sound(o.sound || "accepted");
    var el = document.createElement("div");
    el.className = "mh-cele" + (o.dark ? " drv" : "");
    var cols = ["#fff", "#F9E6DA", "#BC4E1E", "#D6EBE6", "#E8874F"], dots = "";
    for (var i = 0; i < 18; i++) {
      var a = (i / 18) * Math.PI * 2, d = 120 + Math.random() * 90;
      dots += '<i style="background:' + cols[i % cols.length] + ';--x:' + Math.round(Math.cos(a) * d) + 'px;--y:' + Math.round(Math.sin(a) * d) + 'px;--r:' + Math.round(Math.random() * 360) + 'deg"></i>';
    }
    var inner = o.photo ? "" : '<svg viewBox="0 0 48 48" width="58" height="58" fill="none"><path d="M12 25l8 8 16-17" stroke="' + (o.dark ? "#131E1C" : "#0E7566") + '" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    el.innerHTML = '<div class="dots">' + dots + '</div><div class="ring"><div class="disc"' + (o.photo ? ' style="background-image:url(' + o.photo + ')"' : '') + '>' + inner + '</div></div>'
      + '<h2>' + T.esc(o.title || "تمام ✓") + '</h2>' + (o.sub ? '<p>' + T.esc(o.sub) + '</p>' : '');
    document.body.appendChild(el);
    var close = function () { el.classList.add("out"); setTimeout(function () { el.remove(); }, 480); };
    el.addEventListener("click", close);
    setTimeout(close, o.ms || 2200);
  };
  /* توكتوك صغير على الخريطة (للتكاتك القريبة) */
  T.tukIcon = function (busy) {
    return L.divIcon({ className: "mh-tuk", iconSize: [32, 32], iconAnchor: [16, 16],
      html: '<span style="display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#fff;box-shadow:0 4px 10px -3px rgba(19,30,28,.45),0 0 0 2px ' + (busy ? "#BC4E1E" : "#0E7566") + '"><img src="/assets/logo.png" alt="" style="height:22px;width:auto"></span>' });
  };
  /* بيحرّك ماركرات حسب مفتاح: اللي اختفى بيتشال، والجديد بيظهر، والموجود بيتزحلق */
  T.syncMarkers = function (map, store, list, iconFn, tipFn) {
    var seen = {};
    list.forEach(function (p) {
      seen[p.k] = 1;
      if (store[p.k]) store[p.k].setLatLng([p.lat, p.lng]);
      else { store[p.k] = L.marker([p.lat, p.lng], { icon: iconFn(p), interactive: !!tipFn, keyboard: false, zIndexOffset: 500 }).addTo(map); if (tipFn) store[p.k].bindTooltip(tipFn(p)); }
    });
    Object.keys(store).forEach(function (k) { if (!seen[k]) { map.removeLayer(store[k]); delete store[k]; } });
  };
  /* أيقونة السائق على الخريطة، بسهم بيلف مع اتجاهه */
  T.driverIcon = function (h) {
    var arrow = h != null ? '<div style="position:absolute;inset:-9px;transform:rotate(' + (+h) + 'deg)"><div style="position:absolute;top:0;left:50%;margin-left:-6px;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:9px solid #131E1C"></div></div>' : '';
    return L.divIcon({ className: "", iconSize: [32, 32], iconAnchor: [16, 16],
      html: '<div style="position:relative;width:32px;height:32px">' + arrow + '<div style="position:absolute;inset:0;border-radius:50%;background:#131E1C;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);display:grid;place-items:center;color:#fff;font:800 13px/1 \'Readex Pro\',sans-serif">س</div></div>' });
  };
  T.etaText = function (rt) { return rt.min + " دقيقة · " + rt.km.toFixed(1) + " كم"; };

  global.TT = T;

  /* شاشة البداية (1d): بتظهر بس جوه التطبيق المتثبّت، مرة واحدة في أول الفتح */
  try {
    var standalone = (global.matchMedia && matchMedia("(display-mode: standalone)").matches) || /android-app:/.test(document.referrer);
    var p = location.pathname;
    if ((standalone || /[?&]splash=1/.test(location.search)) && !sessionStorage.getItem("mh-splash") && (p === "/" || p === "/index.html" || p === "/driver.html")) {
      sessionStorage.setItem("mh-splash", "1");
      var drv = p === "/driver.html";
      var sp = document.createElement("div");
      sp.setAttribute("aria-hidden", "true");
      sp.className = "mh-splash" + (drv ? " drv" : "");
      sp.innerHTML = '<div class="stage"><span class="rg"></span><span class="rg b"></span><span class="sh"></span><img src="/assets/logo.png" alt=""></div>'
        + '<div class="t">المحطة' + (drv ? ' · سائق' : '') + '</div>'
        + '<div class="s">مشوارك بقى أسهل</div><div class="bar"><i></i></div>';
      (document.body || document.documentElement).appendChild(sp);
      /* نغمة الدخول مع الحركة. لو أندرويد منع الصوت (مفيش لمسة لسه)، بتشتغل مع أول لمسة على شاشة الدخول */
      var t0 = Date.now(), introDone = false;
      var playIntro = function () { if (introDone) return; introDone = true; T.sound("intro"); };
      try {
        var A0 = global.AudioContext || global.webkitAudioContext; sctx = sctx || new A0();
        if (sctx.state === "running") playIntro();
        else sctx.resume().then(function () { if (sctx.state === "running" && Date.now() - t0 < 400) playIntro(); }).catch(function () {});
      } catch (e) {}
      var onTouch = function () { document.removeEventListener("pointerdown", onTouch, true); if (Date.now() - t0 < 15000) playIntro(); };
      document.addEventListener("pointerdown", onTouch, true);
      setTimeout(function () { sp.classList.add("out"); setTimeout(function () { sp.remove(); }, 560); }, 1900);
    }
  } catch (e) {}
})(window);
