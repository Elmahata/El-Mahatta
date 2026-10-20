/* تأكيد رقم الراكب بكود على واتساب — أول دخول، وبعدها بيتحفظ ١٨٠ يوم ويتطلب تاني.
   لو الإدارة لسه ماربطتش واتساب، التأكيد بيعدّي لوحده والتطبيق بيشتغل عادي. */
(function (global) {
  "use strict";
  var TT = global.TT;
  var last10 = function (p) { return String(p || "").replace(/\D/g, "").slice(-10); };
  var key = function (role) { return "mh-sess-" + role; };

  var DAYS = 180 * 864e5;
  function getSess(role) {
    try {
      var s = JSON.parse(localStorage.getItem(key(role)) || "null");
      return s && s.at && Date.now() - s.at < DAYS ? s : null;
    } catch (e) { return null; }
  }
  function setSess(role, s) { s.at = Date.now(); try { localStorage.setItem(key(role), JSON.stringify(s)); } catch (e) {} }
  TT.hasSession = function (role) { return Boolean(getSess(role)); };
  TT.clearSession = function (role) { try { localStorage.removeItem(key(role)); sessionStorage.removeItem(key(role)); } catch (e) {} };
  TT.sessionToken = function (role) { var s = getSess(role); return s ? s.token : ""; };

  function post(path, body) {
    return fetch("/api/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || "حصلت مشكلة"); return j; }); });
  }

  TT.verify = function (phone, role) {
    var s = getSess(role);
    if (s && s.token && last10(s.phone) === last10(phone)) return Promise.resolve(s.token);

    return post("otp/start", { phone: phone, role: role }).then(function (st) {
      if (st.skip) { setSess(role, { phone: phone, token: st.token }); if (global.MHConsent) global.MHConsent.sync(); return st.token; }
      return new Promise(function (resolve, reject) {
        var ov = document.createElement("div");
        ov.style.cssText = "position:fixed;inset:0;z-index:5000;background:rgba(19,30,28,.55);display:flex;align-items:flex-end;justify-content:center";
        ov.innerHTML =
          '<div role="dialog" aria-modal="true" aria-labelledby="otpT" style="background:var(--surface);color:var(--ink);width:100%;max-width:480px;border-radius:22px 22px 0 0;padding:22px 18px calc(22px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:12px">'
          + '<h2 id="otpT" style="margin:0;font:800 20px/1.3 var(--display)">أكّد رقمك</h2>'
          + '<p style="margin:0;color:var(--ink-2)">بعتنالك كود من ٦ أرقام على <b>واتساب</b> على رقم <b class="num" dir="ltr">' + TT.esc(phone) + '</b>.</p>'
          + '<input id="otpIn" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" dir="ltr" style="font:700 28px/1 var(--display);letter-spacing:10px;text-align:center;padding:14px;border:1.5px solid var(--line);border-radius:12px;background:var(--surface-2);color:var(--ink)">'
          + '<p id="otpErr" style="margin:0;color:var(--crit);font-size:14px" hidden></p>'
          + '<p class="hint" style="margin:0">ده أول مرة بس. الدخول هيفضل محفوظ على الموبايل ده ٦ شهور.</p>'
          + '<button class="btn btn-primary btn-wide" id="otpOk">تأكيد</button>'
          + '<div style="display:flex;gap:8px;justify-content:space-between;align-items:center">'
          + '<button class="btn btn-ghost btn-sm" id="otpAgain" disabled>ابعت تاني</button>'
          + '<button class="btn btn-ghost btn-sm" id="otpNo">إلغاء</button></div>'
          + '<p class="hint" style="margin:0">مش واصلك؟ اتأكد إن الرقم عليه واتساب، واستنى دقيقة.</p>'
          + '</div>';
        document.body.appendChild(ov);
        var $ = function (id) { return ov.querySelector("#" + id); };
        var id = st.id, t = null;
        function cooldown(sec) {
          var b = $("otpAgain"); b.disabled = true; clearInterval(t);
          t = setInterval(function () { sec--; b.textContent = sec > 0 ? "ابعت تاني (" + sec + ")" : "ابعت تاني"; if (sec <= 0) { clearInterval(t); b.disabled = false; } }, 1000);
        }
        function err(m) { $("otpErr").textContent = m; $("otpErr").hidden = !m; }
        function close() { clearInterval(t); ov.remove(); }
        cooldown(st.wait || 60);
        setTimeout(function () { $("otpIn").focus(); }, 50);
        $("otpIn").addEventListener("input", function () { this.value = this.value.replace(/\D/g, ""); if (this.value.length === 6) $("otpOk").click(); });
        $("otpOk").addEventListener("click", function () {
          var code = $("otpIn").value; if (code.length !== 6) { err("اكتب الـ ٦ أرقام"); return; }
          var b = this; b.disabled = true; err("");
          post("otp/verify", { id: id, code: code }).then(function (j) {
            setSess(role, { phone: phone, token: j.token });
            if (global.MHConsent) global.MHConsent.sync();
            close(); resolve(j.token);
          }).catch(function (e) { err(e.message); $("otpIn").value = ""; $("otpIn").focus(); }).finally(function () { b.disabled = false; });
        });
        $("otpAgain").addEventListener("click", function () {
          err("");
          post("otp/start", { phone: phone, role: role }).then(function (n) { id = n.id; cooldown(n.wait || 60); TT.toast("اتبعت كود جديد"); }).catch(function (e) { err(e.message); });
        });
        $("otpNo").addEventListener("click", function () { close(); reject(new Error("لازم تأكد رقمك الأول")); });
      });
    });
  };

  /* أول دخول للراكب: الاسم والرقم ← كود واتساب. بيظهر لو مفيش دخول محفوظ أو عدّى عليه ١٨٠ يوم */
  TT.riderGate = function (me, onDone) {
    if (getSess("rider")) return;
    var ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:4900;background:var(--ground);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px";
    ov.innerHTML = '<div class="mh-login" style="width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px">'
      + '<img class="mh-logo" src="/assets/logo.png" alt="المحطة" style="height:72px;width:auto;align-self:center;filter:drop-shadow(0 10px 16px rgba(14,117,102,.25))">'
      + '<h1 style="margin:0;text-align:center;font:800 24px/1.3 var(--display)">أهلاً بيك في المحطة</h1>'
      + '<p style="margin:0;text-align:center;color:var(--ink-2)">اكتب اسمك ورقمك، وهنبعتلك كود على واتساب. ده أول مرة بس.</p>'
      + '<div class="field" style="margin:0"><label for="gName">اسمك</label><input id="gName" autocomplete="name" placeholder="الاسم"></div>'
      + '<div class="field" style="margin:0"><label for="gPhone">رقم موبايلك (عليه واتساب)</label><input id="gPhone" inputmode="tel" autocomplete="tel" placeholder="01xxxxxxxxx" dir="ltr"></div>'
      + '<p id="gErr" style="margin:0;color:var(--crit);font-size:14px" hidden></p>'
      + '<button class="btn btn-primary btn-wide" id="gGo">يلّا ندخل</button>'
      + '<a href="/terms.html" target="_blank" rel="noopener" class="hint" style="text-align:center">الشروط والأحكام وسياسة الخصوصية</a></div>';
    document.body.appendChild(ov);
    var q = function (id) { return ov.querySelector("#" + id); };
    q("gName").value = (me && me.name) || ""; q("gPhone").value = (me && me.phone) || "";
    q("gGo").addEventListener("click", function () {
      var name = q("gName").value.trim(), phone = q("gPhone").value.replace(/\D/g, "");
      var e = q("gErr"); e.hidden = true;
      if (!name) { e.textContent = "اكتب اسمك الأول"; e.hidden = false; q("gName").focus(); return; }
      if (!/^01\d{9}$/.test(phone)) { e.textContent = "اكتب رقم موبايل مصري صحيح (١١ رقم يبدأ بـ 01)"; e.hidden = false; return; }
      var b = this; b.disabled = true;
      TT.verify(phone, "rider").then(function () { ov.remove(); onDone && onDone({ name: name, phone: phone }); })
        .catch(function (err) { e.textContent = err.message; e.hidden = false; })
        .finally(function () { b.disabled = false; });
    });
  };
})(window);
