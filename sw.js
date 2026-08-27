// Incrementar versão aqui para forçar atualização no iPhone
const CACHE = 'pp-v12';
// Caminhos relativos (sem barra inicial) — funciona tanto servido na raiz
// (Mac local, porta 8003) quanto sob um subcaminho (GitHub Pages).
const ASSETS = ['assets/logo.png', 'assets/icon-192.png', 'manifest.json'];

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
     .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
     .then(cls => cls.forEach(c => c.postMessage({ type: 'SW_UPDATED', cache: CACHE })))
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Relay (dados reais/login/notificação): nunca intercepta nem cacheia —
  // sempre direto da rede, senão a resposta de /data fica presa em cache.
  if (url.includes('zyntra-push-relay') || url.includes('api.github.com')) return;

  // index.html: sempre da rede — nunca do cache
  if (e.request.mode === 'navigate' || url.endsWith('/') || url.includes('/index.html')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(res => { caches.open(CACHE).then(c => c.put(e.request, res.clone())); return res; })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Demais assets: cache-first, com fallback à rede
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
// mesmo com o app fechado. Publica através do relay (Cloudflare Worker) em vez
// de escrever direto no GitHub — o token de escrita fica só no relay, nunca aqui
// no código que o navegador baixa.
// Mesma chave VAPID que o relay usa pros outros apps (ele só guarda um par).
const VAPID_PUBLIC_SW = 'BITLfwTQwUU_BYIbbdEXYoUAEp7sy6iiL52Cn-GmnuljgI4F0cPgiT5xgjSM-uV33AIP9LvWf3QrsLR1CRvE-FQ';
const PUSH_RELAY_URL = 'https://zyntra-push-relay.nameless-bonus-004f.workers.dev/subscribe';

// O Service Worker não tem localStorage — a página manda o token por
// postMessage a cada login/renovação. Sem token em memória, a autocorreção
// fica pendente até a página reabrir e mandar de novo (não crítico).
let _sessionTokenSW = null;
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SESSION_TOKEN') _sessionTokenSW = e.data.token;
});

function _urlB64ToUint8SW(b) {
  const p = '='.repeat((4 - b.length % 4) % 4);
  const s = (b + p).replace(/-/g, '+').replace(/_/g, '/');
  const r = atob(s);
  const o = new Uint8Array(r.length);
  for (let i = 0; i < r.length; i++) o[i] = r.charCodeAt(i);
  return o;
}

function _publicarSubGitHubSW(sub) {
  if (!_sessionTokenSW) return Promise.resolve();
  const subJson = sub.toJSON ? sub.toJSON() : sub;
  return fetch(PUSH_RELAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _sessionTokenSW },
    body: JSON.stringify({ app: 'patrimonio', subscription: { endpoint: subJson.endpoint, keys: subJson.keys } })
  }).catch(() => {});
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
  let data = { title: 'Patrimônio Pessoal', body: 'Dados atualizados' };
  try { if (e.data) data = e.data.json(); } catch(ex) {}
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || 'Patrimônio Pessoal', {
        body: data.body || 'Dados atualizados',
        icon: 'assets/icon-192.png',
        badge: 'assets/icon-192.png',
        tag: 'patrimonio-' + Date.now(),
        vibrate: [200, 100, 200],
        renotify: true
      }),
      // A cada push recebido, confirma que a subscription publicada é a mesma
      // que está ativa aqui — corrige qualquer dessincronia silenciosa.
      self.registration.pushManager.getSubscription().then(sub => sub && _publicarSubGitHubSW(sub)).catch(() => {}),
      // Avisa qualquer aba/app aberto pra sincronizar na hora.
      self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(cls => cls.forEach(c => c.postMessage({ type: 'REFRESH_NOW' })))
    ])
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cls => {
      for (const c of cls) {
        if (c.url.includes('/') && 'focus' in c) return c.focus();
      }
      return clients.openWindow('./');
    })
  );
});
