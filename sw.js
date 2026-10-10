/* service worker: بيحفظ الواجهة علشان التطبيق يفتح بسرعة، ولو مفيش نت بيظهر صفحة «مفيش إنترنت». الطلبات نفسها (/api) مش بتتحفظ أبداً. */
const V = "mahatta-v5";
const SHELL = ["/", "/index.html", "/driver.html", "/me.html", "/driver-me.html", "/offline.html", "/assets/style.css", "/assets/common.js", "/assets/verify.js", "/assets/chat.js", "/assets/logo.png", "/assets/icon-192.png", "/assets/icon-driver-192.png"];
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
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => cs.length ? cs[0].focus() : self.clients.openWindow("/driver.html")));
});
