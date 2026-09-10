(function (root) {
  'use strict';
  const SETTINGS_KEY = 'obs-bible:media:v1';
  const categories = ['cameras', 'videos', 'pictures', 'excluded'];
  function classify(kind = '') {
    const id = kind.replace(/_v\d+$/, '');
    if (['dshow_input', 'av_capture_input', 'v4l2_input', 'decklink-input', 'aja_source'].includes(id)) return 'cameras';
    if (['ffmpeg_source', 'vlc_source'].includes(id)) return 'videos';
    if (['image_source', 'slideshow'].includes(id)) return 'pictures';
    return 'excluded';
  }
  function nativeMedia(kind) { return ['ffmpeg_source', 'vlc_source'].includes(kind); }
  function sceneIdentity(scene) { return scene.sceneUuid || scene.sceneName; }
  function itemKey(collection, scene, item) {
    return JSON.stringify([collection, sceneIdentity(scene), item.ownerSceneUuid || item.ownerSceneName, item.sceneItemId]);
  }
  function signature(item) { return JSON.stringify([item.sourceUuid || item.sourceName, item.inputKind]); }
  function blankSettings() { return { version: 1, url: 'ws://127.0.0.1:4455', allowRemote: false, target: null, mappings: {} }; }
  function cleanSettings(value) {
    const result = blankSettings();
    if (!value || value.version !== 1) return result;
    try {
      const url = new URL(value.url);
      if (['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) result.url = url.href;
    } catch (_) { /* Keep safe default. */ }
    result.allowRemote = value.allowRemote === true;
    if (value.target && typeof value.target.collection === 'string' && typeof value.target.sceneName === 'string') {
      result.target = { collection: value.target.collection, sceneName: value.target.sceneName, sceneUuid: typeof value.target.sceneUuid === 'string' ? value.target.sceneUuid : '' };
    }
    for (const [key, mapping] of Object.entries(value.mappings || {})) {
      if (categories.includes(mapping.category) && typeof mapping.signature === 'string') result.mappings[key] = { category: mapping.category, signature: mapping.signature };
    }
    return result;
  }
  class Settings {
    constructor({ storage, demo = false, events } = {}) {
      this.storage = demo ? null : storage;
      this.listeners = new Set(); this.value = this.read();
      if (!demo && events) events.addEventListener('storage', (event) => {
        if (event.key === SETTINGS_KEY || event.key === null) { this.value = this.read(); this.notify(); }
      });
    }
    read() {
      try { return cleanSettings(JSON.parse(this.storage?.getItem(SETTINGS_KEY) || 'null')); }
      catch (_) { return blankSettings(); }
    }
    on(handler) { this.listeners.add(handler); return () => this.listeners.delete(handler); }
    notify() { for (const handler of this.listeners) handler(this.value); }
    update(patch) {
      // Merge the latest disk snapshot so another dock's mappings are not overwritten.
      const next = cleanSettings({ ...(this.storage ? this.read() : this.value), ...patch, version: 1 });
      if (this.storage) this.storage.setItem(SETTINGS_KEY, JSON.stringify(next));
      this.value = next; this.notify();
    }
    export() { return JSON.stringify(cleanSettings(this.value), null, 2); }
  }
  async function inventory(client, scene, inputs) {
    const byName = new Map(inputs.map(input => [input.inputName, input]));
    const result = []; const identities = new Map(); const warnings = [];
    async function visit(owner, group, ancestors, trail, viaScene) {
      if (trail.includes(owner.sceneName) || trail.length >= 12) { warnings.push('A nested scene cycle or depth limit was skipped.'); return; }
      const response = await client.request(group ? 'GetGroupSceneItemList' : 'GetSceneItemList', { sceneName: owner.sceneName });
      for (const raw of response.sceneItems || []) {
        const input = byName.get(raw.sourceName);
        const item = { ...raw, ownerSceneName: owner.sceneName, ownerSceneUuid: owner.sceneUuid || '',
          inputKind: input?.unversionedInputKind || input?.inputKind || raw.inputKind || '',
          sourceUuid: raw.sourceUuid || input?.inputUuid || '',
          path: [...ancestors.map(parent => parent.sourceName), raw.sourceName], ancestors: [...ancestors],
          blocked: viaScene ? 'Nested scene: edit this source in its own scene to avoid changing other outputs.' : '' };
        if (raw.isGroup || raw.sourceType === 'OBS_SOURCE_TYPE_SCENE') {
          await visit({ sceneName: raw.sourceName, sceneUuid: raw.sourceUuid }, raw.isGroup === true,
            [...ancestors, item], [...trail, owner.sceneName], viaScene || !raw.isGroup);
          continue;
        }
        if (!item.blocked && ancestors.some(parent => !parent.sceneItemEnabled)) item.blocked = 'A parent group is hidden. Enable it in OBS, then refresh.';
        const identity = JSON.stringify([item.ownerSceneUuid || item.ownerSceneName, item.sceneItemId]);
        if (identities.has(identity)) {
          identities.get(identity).blocked = 'This item appears through multiple containers. Control it in OBS.';
          warnings.push('A repeated nested item was excluded from control.');
        } else { identities.set(identity, item); result.push(item); }
      }
    }
    await visit(scene, false, [], [], false);
    return { items: result, warnings };
  }
  class Deck {
    constructor(client, settings) {
      this.client = client; this.settings = settings; this.items = []; this.scenes = []; this.inputs = [];
      this.collection = ''; this.selectedKey = null; this.scene = null; this.busy = false;
      this.program = ''; this.warnings = [];
      this.revision = 0;
      client.on?.('event', event => {
        if (/SceneCollection|InputNameChanged|InputRemoved|SceneItemRemoved|SceneItemCreated|SceneNameChanged/.test(event.type)) this.revision++;
      });
    }
    key(item) { return itemKey(this.collection, this.scene, item); }
    category(item) {
      const mapping = this.settings.value.mappings[this.key(item)];
      return mapping && mapping.signature === signature(item) ? mapping.category : 'excluded';
    }
    reviewed(item) {
      return this.settings.value.mappings[this.key(item)]?.signature === signature(item);
    }
    async refresh() {
      const [collections, scenes, inputs] = await Promise.all([
        this.client.request('GetSceneCollectionList'), this.client.request('GetSceneList'), this.client.request('GetInputList')
      ]);
      this.collection = collections.currentSceneCollectionName;
      this.scenes = scenes.scenes || []; this.inputs = inputs.inputs || []; this.program = scenes.currentProgramSceneName || '';
      const target = this.settings.value.target;
      this.scene = target?.collection === this.collection ? this.scenes.find(scene => target.sceneUuid ? scene.sceneUuid === target.sceneUuid : scene.sceneName === target.sceneName) : null;
      this.items = []; this.warnings = [];
      if (this.scene) {
        const found = await inventory(this.client, this.scene, this.inputs);
        this.items = found.items; this.warnings = found.warnings;
      }
      if (!this.items.some(item => this.key(item) === this.selectedKey)) this.selectedKey = null;
      return this;
    }
    chooseScene(scene) {
      this.selectedKey = null;
      this.settings.update({ target: scene ? { collection: this.collection, sceneName: scene.sceneName, sceneUuid: scene.sceneUuid || '' } : null });
    }
    select(key) { this.selectedKey = this.items.some(item => this.key(item) === key) ? key : null; return this.selected(); }
    selected() { return this.items.find(item => this.key(item) === this.selectedKey); }
    review(choices) {
      const mappings = { ...this.settings.value.mappings };
      for (const item of this.items) {
        const category = choices[this.key(item)];
        if (categories.includes(category)) mappings[this.key(item)] = { category, signature: signature(item) };
      }
      this.settings.update({ mappings });
    }
    async validate(key) {
      const targetBefore = JSON.stringify(this.settings.value.target);
      const revisionBefore = this.revision;
      const before = this.items.find(item => this.key(item) === key);
      if (!before) throw new Error('Select a source first.');
      const expected = signature(before);
      await this.refresh();
      if (targetBefore !== JSON.stringify(this.settings.value.target) || revisionBefore !== this.revision) throw new Error('OBS structure or output target changed. Refresh before retrying.');
      const current = this.items.find(item => this.key(item) === key);
      if (!current || signature(current) !== expected) throw new Error('Source identity changed. Review sources again.');
      if (current.blocked) throw new Error(current.blocked);
      if (this.category(current) === 'excluded') throw new Error('Review and include this source in Setup first.');
      return current;
    }
    async visibility(key, enabled, exclusive = false) {
      if (this.busy) throw new Error('Wait for the current action to finish.');
      this.busy = true;
      try {
        const expectedTarget = JSON.stringify(this.settings.value.target);
        const expectedRevision = this.revision;
        const selected = await this.validate(key);
        const category = this.category(selected);
        const peers = exclusive && enabled ? this.items.filter(item => this.category(item) === category && this.key(item) !== key) : [];
        if (peers.some(item => item.blocked)) throw new Error('Exclusive switching is unsafe for this category: a nested or hidden container is included. Exclude it in Setup.');
        // Confirm every item identity immediately before mutation. Never enable parent groups.
        const changes = [{ item: selected, enabled }, ...peers.map(item => ({ item, enabled: false }))];
        const currentCollection = await this.client.request('GetSceneCollectionList');
        if (currentCollection.currentSceneCollectionName !== this.collection || expectedTarget !== JSON.stringify(this.settings.value.target) || expectedRevision !== this.revision) {
          throw new Error('Output scene or scene collection changed. Refresh and review before taking.');
        }
        for (const change of changes) {
          if (expectedTarget !== JSON.stringify(this.settings.value.target) || expectedRevision !== this.revision) throw new Error('Output scene changed during the action. State may be partial; inspect OBS before retrying.');
          if (change.item.sceneItemEnabled === change.enabled) continue;
          await this.client.request('SetSceneItemEnabled', {
            sceneName: change.item.ownerSceneName, sceneItemId: change.item.sceneItemId, sceneItemEnabled: change.enabled
          });
        }
      } finally {
        try { if (this.client.ready) await this.refresh(); } finally { this.busy = false; }
      }
    }
    async transport(key, action) {
      const allowed = ['PLAY', 'PAUSE', 'STOP', 'RESTART', 'NEXT', 'PREVIOUS'];
      if (!allowed.includes(action)) throw new Error('Unsupported media action.');
      if (this.busy) throw new Error('Wait for the current action to finish.');
      this.busy = true;
      try {
        const expectedTarget = JSON.stringify(this.settings.value.target);
        const expectedRevision = this.revision;
        const item = await this.validate(key);
        if (!nativeMedia(item.inputKind)) throw new Error('Transport is available only for OBS Media Source or VLC Source.');
        const currentCollection = await this.client.request('GetSceneCollectionList');
        if (currentCollection.currentSceneCollectionName !== this.collection || expectedTarget !== JSON.stringify(this.settings.value.target) || expectedRevision !== this.revision) throw new Error('Output identity changed. Refresh before retrying.');
        await this.client.request('TriggerMediaInputAction', { inputName: item.sourceName, mediaAction: `OBS_WEBSOCKET_MEDIA_INPUT_ACTION_${action}` });
        return await this.client.request('GetMediaInputStatus', { inputName: item.sourceName });
      } finally { this.busy = false; }
    }
  }
  class Screenshots {
    constructor(client) { this.client = client; this.cache = new Map(); this.queue = []; this.active = 0; }
    get(name, identity = name) {
      if (this.cache.has(identity)) return this.cache.get(identity);
      const promise = new Promise(resolve => { this.queue.push({ name, resolve }); });
      this.cache.set(identity, promise);
      // Bound memory; cache is session-only and explicitly invalidated on reconnect.
      if (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value);
      this.pump(); return promise;
    }
    clear() { this.cache.clear(); for (const task of this.queue.splice(0)) task.resolve(null); }
    pump() {
      while (this.active < 2 && this.queue.length) {
        const task = this.queue.shift(); this.active++;
        this.client.request('GetSourceScreenshot', { sourceName: task.name, imageFormat: 'png', imageWidth: 240 })
          .then(data => task.resolve(/^data:image\/(png|jpe?g);base64,/.test(data.imageData || '') ? data.imageData : null), () => task.resolve(null))
          .finally(() => { this.active--; this.pump(); });
      }
    }
  }
  const api = { SETTINGS_KEY, classify, nativeMedia, itemKey, signature, inventory, Settings, Deck, Screenshots };
  root.MediaDeck = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
