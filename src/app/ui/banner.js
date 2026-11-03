'use strict';
const q = new URLSearchParams(location.search);
document.getElementById('n').textContent = q.get('name') || 'помощник';
document.getElementById('x').onclick = () => window.api.bannerDisconnect();
window.api.onBannerName((n) => { document.getElementById('n').textContent = n; });
