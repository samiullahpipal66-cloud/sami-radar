// Minimal service worker — required by Android/Chrome to allow "Add to Home Screen".
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
self.addEventListener('fetch', () => {}); // no offline caching, just enables installability
