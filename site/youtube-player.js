(function () {
  'use strict';
  // HTTPS gives YouTube an authentic Referer even when OBS's parent is file://.
  // No credentials, library files or user metadata are sent to this page.
  const params = new URLSearchParams(location.hash.slice(1));
  const videoId = params.get('video');
  const token = params.get('token');
  if (parent === window || !/^[A-Za-z0-9_-]{11}$/.test(videoId || '') || !/^[a-f0-9-]{36}$/.test(token || '')) return;
  let player = null;
  let ready = false;
  let parentOrigin = null;
  let heartbeat = null;
  let lastCommand = Date.now();

  function send(type, details = {}) {
    // An opaque file:// parent requires '*'. Only its WindowProxy receives it.
    parent.postMessage({ version: 1, channel: 'emberstage-youtube', token, type, ...details }, parentOrigin && parentOrigin !== 'null' ? parentOrigin : '*');
  }

  function silence() {
    try { player?.mute(); player?.pauseVideo(); } catch (_) {}
  }

  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== parent || !data || data.channel !== 'emberstage-youtube' || data.version !== 1 || data.token !== token) return;
    if (parentOrigin !== null && event.origin !== parentOrigin) return;
    parentOrigin = event.origin;
    lastCommand = Date.now();
    if (!ready) return;
    if (data.type === 'ping') {
      send('state', { state: player.getPlayerState() });
    } else if (data.type === 'mute') {
      data.muted === false ? player.unMute() : player.mute();
    } else if (data.type === 'play') {
      player.playVideo();
    } else if (data.type === 'pause') {
      player.pauseVideo();
    } else if (data.type === 'stop') {
      silence();
      player.destroy();
      ready = false;
      clearInterval(heartbeat);
    }
  });

  window.onYouTubeIframeAPIReady = () => {
    player = new YT.Player('player', {
      width: '100%', height: '100%', videoId,
      playerVars: { origin: location.origin, playsinline: 1, autoplay: 0, controls: 1, rel: 0 },
      events: {
        onReady() {
          ready = true;
          player.mute();
          send('ready');
          heartbeat = setInterval(() => {
            if (Date.now() - lastCommand > 6000) silence();
            send('state', { state: player.getPlayerState() });
          }, 1000);
        },
        onStateChange(event) { send('state', { state: event.data }); },
        onError(event) { silence(); send('error', { code: event.data }); },
        onAutoplayBlocked() { silence(); send('error', { code: 'autoplay' }); }
      }
    });
  };
  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  script.onerror = () => send('error', { code: 'network' });
  document.head.append(script);
  window.addEventListener('pagehide', () => { clearInterval(heartbeat); silence(); player?.destroy(); });
})();
