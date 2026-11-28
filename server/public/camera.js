/* Hosted signaling only. No provider credentials, contribution keys or relay. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const id = location.pathname.split('/').pop();
  const capability = new URLSearchParams(location.hash.slice(1)).get('capability');
  // Keep the capability out of referrers/history and all subsequent URLs.
  history.replaceState(null, '', location.pathname);
  let pc, stream, claim, timer, stopped = false, running = false, next = 0;
  let pendingCandidates = [], remoteCandidates = [], offerSent = false;
  const abort = new AbortController();
  const messages = {
    CAMERA_HTTPS_REQUIRED: 'A secure HTTPS camera link is required. Ask the desk for a new room.',
    CAMERA_PERMISSION_DENIED: 'Camera permission denied. Allow camera access and request a new room.',
    CAMERA_DEVICE_UNAVAILABLE: 'Camera unavailable. Check that a camera is present and not in use, then request a new room.',
    CAMERA_ROOM_UNAVAILABLE: 'Room ended or expired. Ask the desk for a new room.',
    CAMERA_UNAUTHORIZED: 'Camera link or claim rejected. Ask the desk for a new room.',
    CAMERA_CLAIM_CONFLICT: 'This room is already claimed. Ask the desk for a new room.',
    CAMERA_CANDIDATE_INVALID: 'Direct connection requires a supported numeric LAN ICE candidate. Ask the desk for a new room.',
    CAMERA_CANDIDATE_LIMIT: 'Candidate limit reached. Ask the desk for a new room.',
    CAMERA_FINGERPRINT_INVALID: 'Camera identity could not be established. Ask the desk for a new room.',
    CAMERA_APPROVAL_MISMATCH: 'Camera approval did not match. Ask the desk for a new room.',
    CAMERA_NOT_APPROVED: 'Camera approval is no longer valid. Ask the desk for a new room.',
    CAMERA_SIGNAL_REPLAY: 'Camera signaling was already used. Ask the desk for a new room.'
  };
  const failureMessage = error => Object.hasOwn(messages, error?.message) ? messages[error.message]
    : 'Camera signaling failed. Ask the desk for a new room.';
  async function api(action, body) {
    const response = await fetch(`/api/camera/rooms/${encodeURIComponent(id)}/${action}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: abort.signal,
      headers: { Authorization: `Bearer ${capability}`, ...(claim ? { 'X-Camera-Claim': claim.claim_id } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      // Inspect only the exact waiting marker; never display untrusted payloads.
      const data = await response.json().catch(() => ({}));
      const marker = response.status === 404 || response.status === 410 ? 'CAMERA_ROOM_UNAVAILABLE'
        : response.status === 401 || response.status === 403 ? 'CAMERA_UNAUTHORIZED'
        : Object.hasOwn(messages, data?.error) ? data.error : 'CAMERA_REQUEST_FAILED';
      const error = new Error(marker);
      error.approvalPending = action === 'answer' && response.status === 409 && data?.error === 'CAMERA_NOT_APPROVED';
      throw error;
    }
    return response.json();
  }
  function stop(message = 'Stopped. Ask the desk for a new room to start again.') {
    stopped = true; running = false; clearTimeout(timer); abort.abort();
    stream?.getTracks().forEach(track => track.stop()); pc?.close(); $('preview').srcObject = null;
    pendingCandidates = []; remoteCandidates = []; $('stop').disabled = true; $('start').disabled = true; $('status').textContent = message;
  }
  async function sendCandidate(candidate) {
    if (!stopped) await api('candidate', { candidate });
  }
  async function poll() {
    try {
      if (stopped) return;
      // Publisher status is operator-only. The authenticated answer read also
      // checks server expiry/revocation, and returns 409 until explicit approval.
      let answer;
      try { answer = await api('answer'); }
      catch (error) {
        if (!offerSent && error.approvalPending) {
          if (!stopped) timer = setTimeout(poll, 1000);
          return;
        }
        throw error;
      }
      if (stopped) return;
      if (!offerSent) {
        await api('offer', { sdp: pc.localDescription.sdp });
        if (stopped) return;
        offerSent = true;
        for (const candidate of pendingCandidates.splice(0)) await sendCandidate(candidate);
      }
      if (stopped) return;
      if (!pc.remoteDescription && answer.sdp) await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      if (stopped) return;
      const batch = await api(`candidates?from=${next}`);
      if (stopped) return;
      next = batch.next; remoteCandidates.push(...batch.candidates);
      if (pc.remoteDescription) for (const candidate of remoteCandidates.splice(0)) {
        if (stopped) return;
        await pc.addIceCandidate(candidate);
      }
      if (stopped) return;
      $('status').textContent = pc.connectionState === 'connected' ? 'Connected to desk. Program selection stays on the desk.' : 'Approved. Connecting directly to desk…';
      timer = setTimeout(poll, 1000);
    } catch (error) { if (!stopped) stop(failureMessage(error)); }
  }
  $('stop').addEventListener('click', () => stop());
  window.addEventListener('pagehide', () => stop());
  window.addEventListener('beforeunload', () => stop());
  $('start').addEventListener('click', async () => {
    if (running || stopped) return;
    running = true; $('start').disabled = true; $('facing').disabled = true; $('stop').disabled = false;
    try {
      if (location.protocol !== 'https:' || !window.isSecureContext || !capability || !/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error('CAMERA_HTTPS_REQUIRED');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: $('facing').value } } });
      } catch (error) {
        throw new Error(error?.name === 'NotAllowedError' || error?.name === 'SecurityError' ? 'CAMERA_PERMISSION_DENIED' : 'CAMERA_DEVICE_UNAVAILABLE');
      }
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
        else sendCandidate(candidate).catch(error => { if (!stopped) stop(failureMessage(error)); });
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
      await poll();
    } catch (error) { if (!stopped) stop(failureMessage(error)); }
  });
})();
