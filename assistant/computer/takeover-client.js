import RFB from '@novnc/novnc/lib/rfb.js';
const screen = document.getElementById('screen');
const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const rfb = new RFB(screen, `${protocol}//${location.host}/websockify`);
rfb.scaleViewport = true;
rfb.resizeSession = false;
rfb.addEventListener('disconnect', () => { document.getElementById('status').textContent = 'Disconnected'; });
