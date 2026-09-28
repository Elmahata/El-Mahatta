/* أدوات مشتركة بين صفحة الراكب وصفحة الإدارة */
(function (global) {
  "use strict";

  var ZC = ["#0E7566", "#BC4E1E", "#3F6DA8", "#8A5A9E", "#6E8B2E", "#B08A17", "#A9382B", "#4E7D74", "#2F7F8C", "#96602A"];

  /* مركز مدينة كفر صقر: 30°47'47"N 31°37'34"E */
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
      var sfx = "، كفر صقر، الشرقية";
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
      return fetch("/api/" + path, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw Object.assign(new Error(j.error || "خطأ"), { status: r.status });
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

  global.TT = T;
})(window);
