/* موافقة على الشروط — بتظهر مرة واحدة لكل إصدار، وبتتسجّل على السيرفر. لو غيّرت الشروط، زوّد رقم V */
(function () {
  "use strict";
  var V = "1.0";
  var me = document.currentScript;
  var role = (me && me.getAttribute("data-role")) || "rider";
  var K = "mh-terms-" + role;
  function read(k, store) { try { return JSON.parse((store || localStorage).getItem(k) || "null"); } catch (e) { return null; } }
  function device() {
    var d = ""; try { d = localStorage.getItem("mh-dev") || ""; } catch (e) {}
    if (!d) { d = Date.now().toString(36) + Math.random().toString(36).slice(2, 10); try { localStorage.setItem("mh-dev", d); } catch (e) {} }
    return d;
  }
  function phone() {
    var s = role === "driver" ? (read("tt-driver") || read("tt-driver", sessionStorage)) : read("mh-sess-rider");
    return s && s.phone ? String(s.phone).replace(/\D/g, "") : "";
  }
  var TXT = role === "driver"
    ? "قرأت الشروط والأحكام وسياسة الخصوصية ووافقت عليها، وأقرّ بأني مقدّم خدمة مستقل ولست موظفاً لدى إدارة المنصة، وأن رخصي وتأميني ساريان وصحيحان وأني مسئول عنهما، وأن الرصيد رسوم خدمة غير قابلة للاسترداد، وأوافق على جمع بياناتي وموقعي ومعالجتها."
    : "قرأت الشروط والأحكام وسياسة الخصوصية ووافقت عليها، وأوافق على جمع رقمي وموقعي ومعالجتهما وتخزينهما على خوادم قد تكون خارج مصر، وأقرّ بأن السن اللي هسجّل بيه صحيح.";
  function sync() {
    var rec = read(K); if (!rec || rec.v !== V) return;
    var ph = phone();
    if (rec.sent && rec.phone === ph) return;
    fetch("/api/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: role, v: V, at: rec.at, phone: ph, device: device(), text: TXT }) })
      .then(function (r) { if (r.ok) { rec.sent = true; rec.phone = ph; try { localStorage.setItem(K, JSON.stringify(rec)); } catch (e) {} } })
      .catch(function () {});
  }
  window.MHConsent = { sync: sync };
  var cur = read(K); if (cur && cur.v === V) { sync(); return; }
  function show() {
    var ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:6000;background:rgba(19,30,28,.6);display:flex;align-items:flex-end;justify-content:center";
    ov.innerHTML = '<div role="dialog" aria-modal="true" aria-labelledby="tmT" style="background:var(--surface,#fff);color:var(--ink,#1C2826);width:100%;max-width:480px;border-radius:22px 22px 0 0;padding:22px 18px calc(22px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:14px">'
      + '<h2 id="tmT" style="margin:0;font:800 20px/1.3 var(--display,sans-serif)">قبل ما تكمّل</h2>'
      + '<p style="margin:0;color:var(--ink-2,#4A5856)">لازم توافق على الشروط علشان تستخدم «المحطة».</p>'
      + '<a href="/terms.html" target="_blank" rel="noopener" class="btn btn-ghost btn-wide">اقرأ الشروط والأحكام</a>'
      + '<label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;min-height:44px"><input type="checkbox" id="tmOk" style="flex:none;width:22px;height:22px;margin-top:3px;accent-color:var(--accent,#0E7566)"><span style="font-size:14px;line-height:1.7">' + TXT + '</span></label>'
      + '<button class="btn btn-primary btn-wide" id="tmGo" disabled>موافق، كمّل</button></div>';
    document.body.appendChild(ov);
    var cb = ov.querySelector("#tmOk"), go = ov.querySelector("#tmGo");
    cb.addEventListener("change", function () { go.disabled = !cb.checked; });
    go.addEventListener("click", function () {
      try { localStorage.setItem(K, JSON.stringify({ v: V, at: new Date().toISOString() })); } catch (e) {}
      ov.remove(); sync();
    });
  }
  if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);
})();
