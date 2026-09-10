(function () {
  'use strict';
  const output = document.getElementById('output');
  const media = new BroadcastChannel('emberstage-media-v1');
  const stage = new BroadcastChannel('emberstage-visual-v1');
  let objectUrl = '', currentId = '', requestVersion = 0;

  function clear() {
    requestVersion++;
    output.classList.remove('visible', 'cover');
    output.replaceChildren();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = '';
    currentId = '';
  }

  async function show(message) {
    if (!(message.blob instanceof Blob) || !['image', 'video'].includes(message.kind)) return;
    const version = ++requestVersion;
    const nextUrl = URL.createObjectURL(message.blob);
    const element = document.createElement(message.kind === 'image' ? 'img' : 'video');
    element.src = nextUrl;
    element.alt = '';
    try {
      if (message.kind === 'image') {
        if (element.decode) await element.decode();
        else await new Promise((resolve, reject) => { element.onload = resolve; element.onerror = reject; });
      } else {
      element.autoplay = true;
      element.playsInline = true;
      element.loop = message.loop !== false;
      element.muted = message.muted === true;
        await new Promise((resolve, reject) => {
          element.oncanplay = resolve; element.onerror = reject; element.load();
        });
      try { await element.play(); } catch (_) { /* OBS may wait until the source is active. */ }
      }
    } catch (_) {
      URL.revokeObjectURL(nextUrl);
      media.postMessage({ version: 1, type: 'status', state: output.classList.contains('visible') ? 'live' : 'error', id: currentId, reason: 'unsupported-format' });
      return;
    }
    if (version !== requestVersion) { URL.revokeObjectURL(nextUrl); return; }
    const oldUrl = objectUrl;
    objectUrl = nextUrl;
    currentId = message.id;
    output.classList.toggle('cover', message.fit === 'cover');
    output.replaceChildren(element);
    output.classList.add('visible');
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    stage.postMessage({ version: 1, output: 'media', action: 'active' });
    media.postMessage({ version: 1, type: 'status', state: 'live', id: message.id });
  }

  media.onmessage = ({ data }) => {
    if (!data || data.version !== 1) return;
    if (data.type === 'show') show(data);
    else if (data.type === 'hide') { clear(); media.postMessage({ version: 1, type: 'status', state: 'hidden' }); }
    else if (data.type === 'transport') {
      const video = output.querySelector('video');
      if (!video) return;
      if (data.action === 'pause') video.pause();
      if (data.action === 'play') video.play().catch(() => {});
      if (data.action === 'restart') { video.currentTime = 0; video.play().catch(() => {}); }
    } else if (data.type === 'ping') {
      media.postMessage({ version: 1, type: 'status', state: output.classList.contains('visible') ? 'live' : 'hidden', id: currentId });
    }
  };
  stage.onmessage = ({ data }) => {
    if (data?.version === 1 && data.output === 'camera' && data.action === 'active') {
      clear();
      media.postMessage({ version: 1, type: 'status', state: 'hidden', id: '' });
    }
  };
  media.postMessage({ version: 1, type: 'ready' });
  addEventListener('pagehide', () => { clear(); media.close(); stage.close(); });
})();
