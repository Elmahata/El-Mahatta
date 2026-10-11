/* رسايل + مكالمة صوت بالنت بين الراكب والسائق — من غير ما حد يشوف رقم التاني.
   TT.chat.mount({ rid, token?, headers?, msgBtn, callBtn }) — بيرجّع { stop } */
(function (global) {
  "use strict";
  var TT = global.TT, cur = null;

  function api(o, method, body, after) {
    var q = "/api/chat/" + encodeURIComponent(o.rid) + "?after=" + (after || 0) + (o.token ? "&token=" + encodeURIComponent(o.token) : "");
    var h = Object.assign({ "content-type": "application/json" }, o.headers ? o.headers() : {});
    return fetch(q, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || "حصلت مشكلة"); return j; }); });
  }
  function el(html) { var d = document.createElement("div"); d.innerHTML = html; return d.firstChild; }
  function fmt(ts) { return new Date(ts).toLocaleTimeString("ar-EG", { hour: "numeric", minute: "2-digit" }); }
  var QUICK = { r: ["أنا مستنّي قدام الباب", "خمس دقايق وأنزل", "إنت فين؟"], d: ["أنا وصلت", "في الطريق، دقيقتين", "إنت فين بالظبط؟"] };

  TT.chat = {
    mount: function (o) {
      if (cur) cur.stop();
      var st = { after: 0, msgs: [], seen: +(localStorage.getItem("mh-seen-" + o.rid) || 0), me: "", peer: "", open: true, sheet: null, call: null, timer: null, alive: true };
      var self = { stop: stop };
      cur = self;

      function badge() {
        var unread = st.msgs.filter(function (m) { return m.f !== st.me && m.at > st.seen && !m.sys; }).length;
        if (!o.msgBtn) return;
        o.msgBtn.textContent = unread ? "رسايل (" + unread + ")" : "رسالة";
        o.msgBtn.style.boxShadow = unread ? "0 0 0 3px var(--fare)" : "";
        if (o.callBtn) o.callBtn.hidden = !st.open;
      }
      function tick() {
        if (!st.alive) return;
        api(o, "GET", null, st.after).then(function (j) {
          st.me = j.me; st.peer = j.peer; st.open = j.open;
          j.m.forEach(function (m) { st.msgs.push(m); st.after = Math.max(st.after, m.at); });
          var hadNew = j.m.some(function (m) { return m.f !== st.me && !m.sys; });
          if (hadNew && !st.sheet) { try { navigator.vibrate && navigator.vibrate(120); } catch (e) {} }
          j.s.forEach(function (s) { st.after = Math.max(st.after, s.at); onSig(s, j.now); });
          if (st.sheet) render(); badge();
          if (!j.open && !st.call) { stop(); }
        }).catch(function () {});
      }
      function loop() { clearInterval(st.timer); st.timer = setInterval(tick, st.call || st.sheet ? 1500 : 4000); }
      function stop() { st.alive = false; clearInterval(st.timer); if (st.call) hang(false); if (st.sheet) st.sheet.remove(); st.sheet = null; if (cur === self) cur = null; }

      /* ---------- الرسايل ---------- */
      function openSheet() {
        if (st.sheet) return;
        st.sheet = el('<div style="position:fixed;inset:0;z-index:4800;background:rgba(19,30,28,.5);display:flex;align-items:flex-end;justify-content:center">'
          + '<div role="dialog" aria-modal="true" aria-label="رسايل" style="background:var(--surface);color:var(--ink);width:100%;max-width:520px;height:78vh;border-radius:22px 22px 0 0;display:flex;flex-direction:column;overflow:hidden">'
          + '<div style="display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)"><b data-k="peer" style="flex:1;font:700 17px var(--display)"></b>'
          + '<button class="btn btn-primary btn-sm" data-k="call">اتصال بالنت</button><button class="btn btn-ghost btn-sm" data-k="x" aria-label="قفل">✕</button></div>'
          + '<div data-k="list" style="flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:8px;background:var(--surface-2)"></div>'
          + '<div data-k="quick" style="display:flex;gap:6px;padding:8px 12px 0;overflow-x:auto"></div>'
          + '<div style="display:flex;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px))"><input data-k="in" maxlength="500" placeholder="اكتب رسالة…" style="flex:1;min-height:48px;padding:0 14px;border:1.5px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);font:inherit"><button class="btn btn-primary" data-k="send" style="min-width:72px">ابعت</button></div>'
          + '<p class="hint" style="margin:0;padding:0 12px 10px;text-align:center">رقمك مش ظاهر للطرف التاني.</p></div></div>');
        document.body.appendChild(st.sheet);
        var q = function (k) { return st.sheet.querySelector('[data-k="' + k + '"]'); };
        q("x").onclick = function () { st.sheet.remove(); st.sheet = null; loop(); };
        st.sheet.addEventListener("click", function (e) { if (e.target === st.sheet) q("x").onclick(); });
        q("call").onclick = function () { q("x").onclick(); startCall(); };
        q("send").onclick = function () { send(q("in").value); q("in").value = ""; q("in").focus(); };
        q("in").addEventListener("keydown", function (e) { if (e.key === "Enter") q("send").onclick(); });
        q("quick").innerHTML = (QUICK[st.me] || QUICK.r).map(function (t) { return '<button class="btn btn-ghost btn-sm" style="flex:none" data-q="' + TT.esc(t) + '">' + TT.esc(t) + '</button>'; }).join("");
        q("quick").onclick = function (e) { var b = e.target.closest("[data-q]"); if (b) send(b.getAttribute("data-q")); };
        render(); loop();
      }
      function render() {
        if (!st.sheet) return;
        var q = function (k) { return st.sheet.querySelector('[data-k="' + k + '"]'); };
        q("peer").textContent = st.peer || "";
        q("call").hidden = !st.open;
        var L = q("list"), atBottom = L.scrollHeight - L.scrollTop - L.clientHeight < 60;
        L.innerHTML = st.msgs.length ? st.msgs.map(function (m) {
          if (m.sys === "call") return '<div style="align-self:center;font-size:12.5px;color:var(--muted)">☎ ' + (m.f === st.me ? "اتصلت" : st.peer + " اتصل") + ' · ' + fmt(m.at) + '</div>';
          var mine = m.f === st.me;
          return '<div style="align-self:' + (mine ? "flex-start" : "flex-end") + ';max-width:80%;background:' + (mine ? "var(--accent)" : "var(--surface)") + ';color:' + (mine ? "#fff" : "var(--ink)") + ';border:1px solid ' + (mine ? "transparent" : "var(--line)") + ';border-radius:14px;padding:8px 12px;white-space:pre-wrap;word-break:break-word">'
            + TT.esc(m.t) + '<div style="font-size:11px;opacity:.75;margin-top:2px">' + fmt(m.at) + '</div></div>';
        }).join("") : '<div class="hint" style="margin:auto;text-align:center">ابعت رسالة لـ ' + TT.esc(st.peer || "الطرف التاني") + '</div>';
        if (atBottom || !L.dataset.init) { L.scrollTop = L.scrollHeight; L.dataset.init = "1"; }
        st.seen = st.after; try { localStorage.setItem("mh-seen-" + o.rid, st.seen); } catch (e) {}
        badge();
      }
      function send(t) {
        t = (t || "").trim(); if (!t) return;
        api(o, "POST", { text: t }).then(tick).catch(function (e) { TT.toast(e.message); });
      }

      /* ---------- المكالمة ---------- */
      function ice() { return fetch("/api/ice").then(function (r) { return r.json(); }).catch(function () { return { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }; }); }
      function gathered(pc) {
        return new Promise(function (res) {
          if (pc.iceGatheringState === "complete") return res();
          var t = setTimeout(res, 3000);
          pc.addEventListener("icegatheringstatechange", function () { if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); } });
        });
      }
      function sig(type, extra) { return api(o, "POST", { sig: Object.assign({ type: type, call: st.call && st.call.id }, extra || {}) }).catch(function () {}); }
      function ui(state, label) {
        var c = st.call; if (!c) return;
        if (!c.box) {
          c.box = el('<div role="dialog" aria-modal="true" aria-label="مكالمة" style="position:fixed;inset:0;z-index:4950;background:#131E1C;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:calc(48px + env(safe-area-inset-top,0px)) 24px calc(40px + env(safe-area-inset-bottom,0px))">'
            + '<div style="display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center"><div style="width:96px;height:96px;border-radius:50%;background:#0E7566;display:grid;place-items:center;font:800 40px var(--display)" data-k="av"></div>'
            + '<b data-k="nm" style="font:800 24px var(--display)"></b><span data-k="lb" style="color:#AEBCB7"></span><span class="hint" style="color:#7E8D88">مكالمة بالنت — رقمك مش ظاهر</span></div>'
            + '<div data-k="act" style="display:flex;gap:28px"></div><audio data-k="au" autoplay playsinline></audio></div>');
          document.body.appendChild(c.box);
        }
        var q = function (k) { return c.box.querySelector('[data-k="' + k + '"]'); };
        q("av").textContent = (st.peer || "؟").charAt(0); q("nm").textContent = st.peer || "";
        q("lb").textContent = label;
        var B = function (k, txt, bg) { return '<button data-a="' + k + '" style="width:72px;height:72px;border-radius:50%;border:0;background:' + bg + ';color:#fff;font:700 13px var(--body);cursor:pointer">' + txt + '</button>'; };
        q("act").innerHTML = state === "ringing" ? B("no", "رفض", "#A9382B") + B("yes", "رد", "#1C7449")
          : state === "live" ? B("mute", c.muted ? "صوت" : "كتم", "#2B3633") + B("end", "إنهاء", "#A9382B")
          : B("end", "إنهاء", "#A9382B");
        q("act").onclick = function (e) {
          var a = e.target.closest("[data-a]"); if (!a) return; a = a.getAttribute("data-a");
          if (a === "yes") answer(); else if (a === "no") { sig("decline"); hang(false); }
          else if (a === "mute") { c.muted = !c.muted; c.local && c.local.getAudioTracks().forEach(function (t) { t.enabled = !c.muted; }); ui("live", q("lb").textContent); }
          else if (a === "end") hang(true);
        };
      }
      function ring(on) {
        var c = st.call; if (!c) return;
        clearInterval(c.ringT);
        if (!on) return;
        var beep = function () {
          try { navigator.vibrate && navigator.vibrate([300, 150, 300]); } catch (e) {}
          try { var A = c.ac || (c.ac = new (global.AudioContext || global.webkitAudioContext)()); var g = A.createGain(), osc = A.createOscillator(); osc.frequency.value = 660; g.gain.value = .12; osc.connect(g); g.connect(A.destination); osc.start(); osc.stop(A.currentTime + .5); } catch (e) {}
        };
        beep(); c.ringT = setInterval(beep, 1800);
      }
      function newPc(cfg) {
        var c = st.call, pc = new RTCPeerConnection(cfg);
        pc.ontrack = function (e) { var au = c.box && c.box.querySelector("audio"); if (au) au.srcObject = e.streams[0]; };
        pc.onconnectionstatechange = function () {
          if (pc.connectionState === "connected") { ring(false); c.t0 = Date.now(); clearInterval(c.clock); c.clock = setInterval(function () { var s = Math.floor((Date.now() - c.t0) / 1000); ui("live", Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0")); }, 1000); ui("live", "0:00"); }
          if (pc.connectionState === "failed") { TT.toast("المكالمة مااتوصلتش — جرّب رسالة"); hang(true); }
        };
        return pc;
      }
      function mic() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject(new Error("الموبايل ده مش بيدعم المكالمات بالنت"));
        return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
          .catch(function () { throw new Error("لازم تسمح للتطبيق يستخدم المايك"); });
      }
      function startCall() {
        if (st.call) return;
        st.call = { id: Math.random().toString(36).slice(2, 10), role: "caller" };
        ui("calling", "بيرن…"); loop();
        Promise.all([mic(), ice()]).then(function (r) {
          var c = st.call; if (!c) { r[0].getTracks().forEach(function (t) { t.stop(); }); return; }
          c.local = r[0]; c.pc = newPc(r[1]);
          c.local.getTracks().forEach(function (t) { c.pc.addTrack(t, c.local); });
          return c.pc.createOffer().then(function (of) { return c.pc.setLocalDescription(of); })
            .then(function () { return gathered(c.pc); })
            .then(function () { return sig("offer", { sdp: c.pc.localDescription.sdp }); })
            .then(function () { c.noAns = setTimeout(function () { if (st.call === c && !c.t0) { TT.toast("مفيش رد"); hang(true); } }, 45000); });
        }).catch(function (e) { TT.toast(e.message); hang(true); });
      }
      function answer() {
        var c = st.call; if (!c || !c.offer) return;
        ring(false); ui("calling", "بيتوصّل…");
        Promise.all([mic(), ice()]).then(function (r) {
          c.local = r[0]; c.pc = newPc(r[1]);
          c.local.getTracks().forEach(function (t) { c.pc.addTrack(t, c.local); });
          return c.pc.setRemoteDescription({ type: "offer", sdp: c.offer })
            .then(function () { return c.pc.createAnswer(); }).then(function (a) { return c.pc.setLocalDescription(a); })
            .then(function () { return gathered(c.pc); })
            .then(function () { return sig("answer", { sdp: c.pc.localDescription.sdp }); });
        }).catch(function (e) { TT.toast(e.message); sig("decline"); hang(false); });
      }
      function hang(tell) {
        var c = st.call; if (!c) return;
        if (tell) sig("bye");
        ring(false); clearInterval(c.clock); clearTimeout(c.noAns);
        try { c.pc && c.pc.close(); } catch (e) {}
        c.local && c.local.getTracks().forEach(function (t) { t.stop(); });
        try { c.ac && c.ac.close(); } catch (e) {}
        c.box && c.box.remove();
        st.call = null; loop();
      }
      function onSig(s, now) {
        var c = st.call;
        if (s.type === "offer") {
          if (now - s.at > 40000) return;
          if (c) { if (c.role === "caller" && st.me === "r") { hang(false); } else return; }
          st.call = { id: s.call, role: "callee", offer: s.sdp };
          ui("ringing", "بيتصل بيك…"); ring(true); loop();
        } else if (!c || s.call !== c.id) {
          return;
        } else if (s.type === "answer" && c.pc) {
          c.pc.setRemoteDescription({ type: "answer", sdp: s.sdp }).catch(function () {});
          ui("calling", "بيتوصّل…");
        } else if (s.type === "decline") { TT.toast("مش قادر يرد دلوقتي"); hang(false); }
        else if (s.type === "bye") { hang(false); }
      }

      if (o.msgBtn) o.msgBtn.onclick = function (e) { e.preventDefault(); openSheet(); };
      if (o.callBtn) o.callBtn.onclick = function (e) { e.preventDefault(); startCall(); };
      tick(); loop();
      return self;
    },
  };
})(window);
