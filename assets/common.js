/* أدوات مشتركة بين صفحة الراكب وصفحة الإدارة */
(function (global) {
  "use strict";

  var ZC = ["#0E7566", "#BC4E1E", "#3F6DA8", "#8A5A9E", "#6E8B2E", "#B08A17", "#A9382B", "#4E7D74", "#2F7F8C", "#96602A"];

  /* مركز افتراضي للخريطة — بتروح لمكان الراكب أو الأماكن المسجّلة تلقائياً */
  var CENTER = [30.7964, 31.6261];

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
      return fetch("/api/" + path, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      }).then(function (r) {
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
        return { coords: rt.geometry.coordinates.map(function (p) { return [p[1], p[0]]; }), km: rt.distance / 1000, min: Math.max(1, Math.round(rt.duration / 60 * 1.4)), road: true };
      })
      .catch(function () { delete RC[k]; return straight; });
    return RC[k];
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
    if (standalone && !sessionStorage.getItem("mh-splash") && (p === "/" || p === "/index.html" || p === "/driver.html")) {
      sessionStorage.setItem("mh-splash", "1");
      var drv = p === "/driver.html";
      var sp = document.createElement("div");
      sp.setAttribute("aria-hidden", "true");
      sp.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;transition:opacity .35s;background:" + (drv ? "#131E1C" : "#0E7566");
      sp.innerHTML = '<img src="/assets/logo.png" alt="" style="height:96px;width:auto;filter:brightness(0) invert(1)">'
        + '<div style="font:800 30px/1.2 \'Readex Pro\',sans-serif;color:#fff">المحطة' + (drv ? ' · سائق' : '') + '</div>'
        + '<div style="font:500 15px \'IBM Plex Sans Arabic\',sans-serif;color:#D6EBE6">مشوارك بقى أسهل</div>';
      (document.body || document.documentElement).appendChild(sp);
      setTimeout(function () { sp.style.opacity = "0"; setTimeout(function () { sp.remove(); }, 400); }, 1100);
    }
  } catch (e) {}
})(window);
