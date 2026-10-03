/* OBS WebSocket v5. No connection, retry, or OBS mutation happens on import. */
(function (root) {
  'use strict';
  class OBSClient {
    constructor(options = {}) {
      this.WebSocket = options.WebSocket || root.WebSocket;
      this.crypto = options.crypto || root.crypto;
      this.timeout = options.timeout || 8000;
      this.pending = new Map();
      this.listeners = new Map();
      this.sequence = 0;
      this.ready = false;
    }
    on(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
      return () => this.listeners.get(type)?.delete(handler);
    }
    emit(type, data) {
      for (const handler of this.listeners.get(type) || []) {
        try { handler(data); } catch (_) { /* One view must not break the connection. */ }
      }
    }
    async hash(value) {
      if (!this.crypto?.subtle) throw new Error('Authentication needs a secure localhost page with Web Crypto.');
      const bytes = await this.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return btoa(String.fromCharCode(...new Uint8Array(bytes)));
    }
    connect({ url = 'ws://127.0.0.1:4455', password = '', allowRemote = false, requireAuthentication = false } = {}) {
      let endpoint;
      try {
        endpoint = new URL(url);
        if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
          throw new Error('Use a WebSocket URL without credentials or query parameters.');
        }
        const local = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
        if (!local && (!allowRemote || endpoint.protocol !== 'wss:')) {
          throw new Error('Use a loopback address, or explicitly allow a remote secure wss:// connection.');
        }
      } catch (error) { return Promise.reject(new Error(error.message.startsWith('Use ') ? error.message : 'Enter a valid WebSocket URL.')); }
      this.disconnect();
      this.emit('status', { state: 'connecting' });
      return new Promise((resolve, reject) => {
        let socket;
        try { socket = new this.WebSocket(endpoint.href); } catch (_) {
          this.emit('status', { state: 'disconnected' });
          reject(new Error('Could not open WebSocket. Check the connection address.')); return;
        }
        this.socket = socket;
        let settled = false;
        const fail = (error) => {
          password = '';
          clearTimeout(timer);
          if (!settled) { settled = true; reject(error); }
          if (this.socket === socket) this.disconnect(error);
        };
        const timer = setTimeout(() => fail(new Error('OBS connection timed out. Check Tools → WebSocket Server Settings.')), this.timeout);
        this.cancelConnect = fail;
        socket.onmessage = async (event) => {
          if (this.socket !== socket) return;
          let packet;
          try { packet = JSON.parse(event.data); } catch (_) { fail(new Error('Invalid OBS WebSocket response.')); return; }
          const data = packet.d || {};
          try {
            if (packet.op === 0) {
              if (settled || this.identifying) return;
              if (requireAuthentication && (!data.authentication || typeof data.authentication.salt !== 'string' || typeof data.authentication.challenge !== 'string')) {
                throw new Error('Authenticated OBS connection is required.');
              }
              this.identifying = true;
              const identify = { rpcVersion: 1, eventSubscriptions: 399 };
              if (data.authentication) {
                const secret = await this.hash(password + data.authentication.salt);
                identify.authentication = await this.hash(secret + data.authentication.challenge);
              }
              password = '';
              if (this.socket === socket) socket.send(JSON.stringify({ op: 1, d: identify }));
            } else if (packet.op === 2 && this.identifying && !settled) {
              clearTimeout(timer); settled = true; this.ready = true; this.cancelConnect = null;
              this.emit('status', { state: 'connected' }); resolve(this);
            } else if (packet.op === 7) {
              const entry = this.pending.get(data.requestId);
              if (!entry) return;
              clearTimeout(entry.timer); this.pending.delete(data.requestId);
              if (data.requestStatus?.result) entry.resolve(data.responseData || {});
              else entry.reject(new Error(`${entry.type} failed (OBS ${data.requestStatus?.code || 'error'}). Refresh sources and check OBS.`));
            } else if (packet.op === 5 && this.ready) {
              this.emit('event', { type: data.eventType, data: data.eventData || {} });
              this.emit(data.eventType, data.eventData || {});
            }
          } catch (error) { fail(error); }
        };
        socket.onerror = () => fail(new Error('Cannot reach OBS. Check the address and WebSocket server.'));
        socket.onclose = (event) => fail(new Error(event.code === 4009 ? 'OBS authentication failed. Check your password and try again.' : 'OBS disconnected. Reconnect when ready.'));
      });
    }
    request(type, requestData = {}) {
      if (!this.ready || !this.socket) return Promise.reject(new Error('Connect to OBS first.'));
      const requestId = `media-${++this.sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error(`${type} timed out. State is unknown; refresh before retrying.`));
        }, this.timeout);
        this.pending.set(requestId, { resolve, reject, timer, type });
        try { this.socket.send(JSON.stringify({ op: 6, d: { requestType: type, requestId, requestData } })); }
        catch (_) { clearTimeout(timer); this.pending.delete(requestId); reject(new Error('OBS connection lost.')); }
      });
    }
    disconnect(reason = new Error('Disconnected from OBS.')) {
      const socket = this.socket;
      this.socket = null; this.ready = false; this.identifying = false;
      const cancel = this.cancelConnect; this.cancelConnect = null;
      if (cancel) cancel(reason);
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(reason); }
      this.pending.clear();
      if (socket) { socket.onmessage = socket.onerror = socket.onclose = null; socket.close(); }
      this.emit('status', { state: 'disconnected' });
    }
  }
  root.OBSClient = OBSClient;
  if (typeof module !== 'undefined') module.exports = OBSClient;
})(typeof window !== 'undefined' ? window : globalThis);
