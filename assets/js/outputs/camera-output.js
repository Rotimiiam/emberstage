(function () {
  'use strict';
  const output = document.getElementById('output');
  const cameras = new BroadcastChannel('emberstage-camera-v1');
  const stage = new BroadcastChannel('emberstage-visual-v1');
  let stream, currentDeviceId = '', requestVersion = 0;

  function stop(state = 'hidden') {
    requestVersion++;
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    output.replaceChildren();
    output.classList.remove('visible', 'cover');
    currentDeviceId = '';
    cameras.postMessage({ version: 1, type: 'status', state, deviceId: '' });
  }

  async function take(message) {
    const version = ++requestVersion;
    let nextStream;
    try {
      nextStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: message.deviceId } } });
      const nextVideo = document.createElement('video');
      nextVideo.autoplay = true; nextVideo.muted = true; nextVideo.playsInline = true;
      nextVideo.srcObject = nextStream;
      await nextVideo.play();
      if (version !== requestVersion) { nextStream.getTracks().forEach(track => track.stop()); return; }
      const oldStream = stream;
      stream = nextStream;
      currentDeviceId = message.deviceId;
      output.classList.toggle('cover', message.fit === 'cover');
      output.replaceChildren(nextVideo);
      output.classList.add('visible');
      if (oldStream) oldStream.getTracks().forEach(track => track.stop());
      stage.postMessage({ version: 1, output: 'camera', action: 'active' });
      cameras.postMessage({ version: 1, type: 'status', state: 'live', deviceId: message.deviceId });
    } catch (_) {
      if (nextStream) nextStream.getTracks().forEach(track => track.stop());
      cameras.postMessage({ version: 1, type: 'status', state: stream ? 'live' : 'error', deviceId: currentDeviceId });
    }
  }

  cameras.onmessage = ({ data }) => {
    if (!data || data.version !== 1) return;
    if (data.type === 'take' && typeof data.deviceId === 'string') take(data);
    else if (data.type === 'hide') stop();
    else if (data.type === 'ping') cameras.postMessage({ version: 1, type: 'status', state: stream ? 'live' : 'hidden', deviceId: currentDeviceId });
  };
  stage.onmessage = ({ data }) => { if (data?.version === 1 && data.output === 'media' && data.action === 'active') stop(); };
  cameras.postMessage({ version: 1, type: 'ready' });
  addEventListener('pagehide', () => { stop(); cameras.close(); stage.close(); });
})();
