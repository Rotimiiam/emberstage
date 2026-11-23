/* Hosted signaling only. No provider credentials, contribution keys or relay. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const id = location.pathname.split('/').pop();
  const capability = new URLSearchParams(location.hash.slice(1)).get('capability');
  // Keep the capability out of referrers/history and all subsequent URLs.
  history.replaceState(null, '', location.pathname);
  let pc, stream, claim, timer, expiryTimer, stopped = false, running = false, next = 0;
  let pendingCandidates = [], remoteCandidates = [], offerSent = false;
  const abort = new AbortController();
  async function api(action, body) {
    const response = await fetch(`/api/camera/rooms/${encodeURIComponent(id)}/${action}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: abort.signal,
      headers: { Authorization: `Bearer ${capability}`, ...(claim ? { 'X-Camera-Claim': claim.claim_id } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) throw new Error('CAMERA_REQUEST_FAILED');
    return response.json();
  }
  function stop(message = 'Stopped. Ask the desk for a new room to start again.') {
    stopped = true; running = false; clearTimeout(timer); clearTimeout(expiryTimer); abort.abort();
    stream?.getTracks().forEach(track => track.stop()); pc?.close(); $('preview').srcObject = null;
    pendingCandidates = []; remoteCandidates = []; $('stop').disabled = true; $('start').disabled = true; $('status').textContent = message;
  }
  async function sendCandidate(candidate) {
    if (!stopped) await api('candidate', { candidate });
  }
  async function poll() {
    try {
      if (stopped) return;
      const status = await api('status');
      if (stopped) return;
      if (status.phase === 'revoked' || Date.parse(status.expires_at) <= Date.now()) return stop('Room ended.');
      if (['approved', 'offered', 'answered'].includes(status.phase)) {
        if (!offerSent) {
          await api('offer', { sdp: pc.localDescription.sdp });
          if (stopped) return;
          offerSent = true;
          for (const candidate of pendingCandidates.splice(0)) await sendCandidate(candidate);
        }
        if (!pc.remoteDescription) {
          const answer = await api('answer');
          if (stopped) return;
          if (answer.sdp) await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
        }
        const batch = await api(`candidates?from=${next}`);
        if (stopped) return;
        next = batch.next; remoteCandidates.push(...batch.candidates);
        if (pc.remoteDescription) for (const candidate of remoteCandidates.splice(0)) await pc.addIceCandidate(candidate);
        $('status').textContent = pc.connectionState === 'connected' ? 'Connected to desk. Program selection stays on the desk.' : 'Approved. Connecting directly to desk…';
      }
      timer = setTimeout(poll, 1000);
    } catch { if (!stopped) stop('Connection ended. Ask the desk for a new room.'); }
  }
  $('stop').addEventListener('click', () => stop());
  window.addEventListener('pagehide', () => stop());
  window.addEventListener('beforeunload', () => stop());
  $('start').addEventListener('click', async () => {
    if (running || stopped) return;
    running = true; $('start').disabled = true; $('facing').disabled = true; $('stop').disabled = false;
    try {
      if (location.protocol !== 'https:' || !window.isSecureContext || !capability || !/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error('CAMERA_HTTPS_REQUIRED');
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: $('facing').value } } });
      if (stopped) { stream.getTracks().forEach(track => track.stop()); return; }
      $('preview').srcObject = stream;
      // No hosted TURN/media relay. Host/srflx connectivity must be proven separately.
      pc = new RTCPeerConnection({ iceServers: [] });
      pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'failed') stop('Direct connection failed.'); });
      pc.addEventListener('icecandidate', event => {
        if (!event.candidate || stopped) return;
        const c = event.candidate.toJSON();
        const candidate = { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex };
        if (!offerSent) { if (pendingCandidates.length < 64) pendingCandidates.push(candidate); else stop('Candidate limit reached.'); }
        else sendCandidate(candidate).catch(() => { if (!stopped) stop('Connection ended.'); });
      });
      for (const track of stream.getVideoTracks()) {
        const transceiver = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
        const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs;
        if (codecs && transceiver.setCodecPreferences) transceiver.setCodecPreferences([
          ...codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264'), ...codecs.filter(c => c.mimeType.toLowerCase() !== 'video/h264')
        ]);
      }
      await pc.setLocalDescription(await pc.createOffer());
      if (stopped) return;
      const fingerprints = [...pc.localDescription.sdp.matchAll(/^a=fingerprint:sha-256 ([^\r\n]+)\r?$/gm)].map(m => m[1]);
      if (!fingerprints.length || fingerprints.some(f => f !== fingerprints[0])) throw new Error('CAMERA_FINGERPRINT_INVALID');
      claim = await api('claim', { fingerprint: fingerprints[0] });
      if (stopped) return;
      $('code').textContent = claim.code; $('status').textContent = 'Compare this code with your desk. Waiting for explicit approval…';
      const status = await api('status');
      expiryTimer = setTimeout(() => stop('Room expired.'), Math.max(0, Date.parse(status.expires_at) - Date.now()));
      await poll();
    } catch { if (!stopped) stop('Unable to start. Check HTTPS/camera permission and request a new room.'); }
  });
})();
