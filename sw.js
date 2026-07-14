// Incrementar versão aqui para forçar atualização no iPhone
const CACHE = 'pp-v10';
const ASSETS = ['/patrimonio-pessoal-app/assets/logo.png', '/patrimonio-pessoal-app/assets/icon-192.png', '/patrimonio-pessoal-app/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      // Cache cada asset individualmente — falha num não quebra o install
      Promise.allSettled(ASSETS.map(a => c.add(a)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // GitHub API: nunca intercepta — passa direto
  if (url.hostname === 'api.github.com') return;

  // HTML: network-first
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Assets: cache-first, com fallback à rede
  e.respondWith(
    caches.match(e.request).then(r => {
      if (r) return r;
      return fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      });
    })
  );
});

// ── Autocorreção de subscription — roda dentro do Service Worker, então funciona
// mesmo com o app fechado (sem depender do app reaberto em primeiro plano pra
// detectar/republicar uma subscription trocada ou dessincronizada).
// Token de grão fino, restrito só ao repo patrimonio-dados (Contents: read/write)
const GH_TOKEN_SW = 'github_pat_11CFLNNEQ0' + '1PYxMxCwYRmo_Kh4C4gp6bHSBv9IjyQXMunOfcCGZF4Y3d625gnYyOZa74ZQJG2OsVjq2Ny0';
const VAPID_PUBLIC_SW = 'BMSTghVnCWVpM3pV7_WxgQJOJBpAFe3rDQgUSDIcIPoGvEJQ6yynu4TXzgtL6hHJD0Ip9oFkqoBdIWAOSR4c3Xg';
const PUSH_SUB_API_SW = 'https://api.github.com/repos/ZyntraGlobal/patrimonio-dados/contents/push-sub.json';

function _urlB64ToUint8SW(b) {
  const p = '='.repeat((4 - b.length % 4) % 4);
  const s = (b + p).replace(/-/g, '+').replace(/_/g, '/');
  const r = atob(s);
  const o = new Uint8Array(r.length);
  for (let i = 0; i < r.length; i++) o[i] = r.charCodeAt(i);
  return o;
}

function _publicarSubGitHubSW(sub) {
  const hh = { 'Authorization': 'Bearer ' + GH_TOKEN_SW, 'Accept': 'application/vnd.github+json', 'User-Agent': 'PatrimonioPessoal-App', 'Content-Type': 'application/json' };
  return fetch(PUSH_SUB_API_SW, { headers: hh, cache: 'no-store' })
    .then(r => r.status === 404 ? null : r.json())
    .then(info => {
      let lista = [];
      if (info && info.content) {
        try { lista = JSON.parse(atob(info.content.replace(/\n/g, ''))); } catch(e) { lista = []; }
      }
      if (!Array.isArray(lista)) lista = [];
      lista = lista.filter(s => s.endpoint !== sub.endpoint);
      lista.push(sub);
      const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(lista))));
      const payload = { message: 'update push subscription (sw)', content: b64 };
      if (info && info.sha) payload.sha = info.sha;
      return fetch(PUSH_SUB_API_SW, { method: 'PUT', headers: hh, cache: 'no-store', body: JSON.stringify(payload) });
    })
    .catch(() => {});
}

// O navegador trocou a subscription sozinho (ex: expirou) — reinscreve e republica
// na hora, sem depender do app ser reaberto pra detectar isso.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: _urlB64ToUint8SW(VAPID_PUBLIC_SW) })
      .then(sub => _publicarSubGitHubSW(sub))
      .catch(() => {})
  );
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: 'Patrimônio Pessoal', body: 'Você tem contas a vencer!' };
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/patrimonio-pessoal-app/assets/icon-192.png',
        badge: '/patrimonio-pessoal-app/assets/icon-192.png',
        vibrate: [200, 100, 200],
        data: { url: '/patrimonio-pessoal-app/' }
      }),
      // A cada push recebido, confirma que a subscription publicada no GitHub é a
      // mesma que está ativa aqui — corrige qualquer dessincronia silenciosa.
      self.registration.pushManager.getSubscription().then(sub => sub && _publicarSubGitHubSW(sub)).catch(() => {})
    ])
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data.url || '/patrimonio-pessoal-app/'));
});
