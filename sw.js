/* 오프라인 캐시 — 앱 파일을 폰에 저장해 인터넷 없이 실행
 * 화면을 수정해 배포할 때 VERSION 값을 올리면 폰이 새 파일을 받습니다. */
const VERSION = "asset-offline-v1.0.0";
const FILES = ["./", "index.html", "app.js", "app.css", "manifest.json", "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png",
  "vendor/html5-qrcode.min.js", "vendor/xlsx.full.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
/* 캐시 우선 + 백그라운드 갱신(온라인이면 다음 실행 때 최신 파일) */
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || c.match("index.html");
  }));
});
