/* service worker: بيحفظ الواجهة علشان التطبيق يفتح بسرعة، ولو مفيش نت بيظهر صفحة «مفيش إنترنت». الطلبات نفسها (/api) مش بتتحفظ أبداً. */
const V = "mahatta-v82";
const SHELL = ["/", "/index.html", "/driver.html", "/me.html", "/driver-me.html", "/offline.html", "/assets/style.css", "/assets/common.js", "/assets/push.js", "/assets/fcm-config.js", "/assets/family.js", "/assets/verify.js", "/assets/terms.js", "/terms.html", "/assets/chat.js", "/assets/logo.png", "/assets/icon-192.png", "/assets/icon-driver-192.png"];
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).catch(() => {})); });
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api")) return;
  /* الأول من النت (علشان التحديثات توصل على طول)، ولو مفيش نت من المحفوظ */
  e.respondWith(
    fetch(e.request).then((r) => { const cp = r.clone(); caches.open(V).then((c) => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request).then((m) => m || (e.request.mode === "navigate" ? caches.match("/offline.html") : Response.error())))
  );
});
/* إشعار من Firebase والتطبيق مقفول. لو التطبيق مفتوح قدّام السائق/الراكب، الصفحة نفسها بتعمل التنبيه فمش بنكرّره */
self.addEventListener("push", (e) => {
  let p = {}; try { p = e.data ? e.data.json() : {}; } catch (x) {}
  const d = p.data || p;
  const urgent = d.kind === "request" || d.kind === "sos";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    if (cs.some((c) => c.visibilityState === "visible") && d.kind !== "sos") { cs.forEach((c) => c.postMessage({ mhPush: d })); return; }
    return self.registration.showNotification(d.title || "المحطة", {
      body: d.body || "", icon: "/assets/icon-192.png", badge: "/assets/icon-192.png", dir: "rtl", lang: "ar",
      tag: d.tag || d.kind || "mh", renotify: true, requireInteraction: urgent,
      vibrate: d.kind === "sos" ? [400, 150, 400, 150, 400, 150, 800] : urgent ? [300, 120, 300, 120, 600] : [150, 80, 150],
      data: { url: d.url || "/" },
    });
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    const c = cs.find((x) => new URL(x.url).pathname === new URL(url, self.location.origin).pathname) || cs[0];
    if (c) return c.focus().then((w) => (w && w.navigate && new URL(w.url).pathname !== new URL(url, self.location.origin).pathname ? w.navigate(url) : w));
    return self.clients.openWindow(url);
  }));
});
