/* Only instantiated by the explicit ?demo=1 presentation mode. Never uses storage or WebSocket. */
(function (root) {
  'use strict';
  class DemoOBS {
    constructor() {
      this.ready = false; this.listeners = new Map(); this.calls = [];
      this.scenes = [{ sceneName: 'Main output', sceneUuid: 'demo-main' }, { sceneName: 'Holding screen', sceneUuid: 'demo-hold' }];
      this.inputs = []; this.items = [];
      const add = (label, kind, count) => {
        for (let index = 1; index <= count; index++) {
          const id = this.items.length + 1;
          this.inputs.push({ inputName: `${label} ${String(index).padStart(2, '0')}`, inputKind: kind, inputUuid: `demo-input-${id}` });
          this.items.push({ sceneItemId: id, sourceName: this.inputs[id - 1].inputName, sourceUuid: `demo-input-${id}`,
            inputKind: kind, sceneItemEnabled: index === 1 && kind === 'dshow_input', isGroup: false, sourceType: 'OBS_SOURCE_TYPE_INPUT' });
        }
      };
      add('Camera', 'dshow_input', 5); add('Picture', 'image_source', 24); add('Video', 'ffmpeg_source', 4);
      add('Scripture + Songs', 'browser_source', 1);
      this.states = {};
    }
    on(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); return () => this.listeners.get(type)?.delete(fn); }
    emit(type, data) { for (const fn of this.listeners.get(type) || []) fn(data); }
    async connect() { this.ready = true; this.emit('status', { state: 'connected' }); return this; }
    disconnect() { this.ready = false; this.emit('status', { state: 'disconnected' }); }
    async request(type, data = {}) {
      if (!this.ready) throw new Error('Demo disconnected. Reload to reset.');
      this.calls.push({ type, data });
      switch (type) {
        case 'GetSceneCollectionList': return { currentSceneCollectionName: 'DEMO', sceneCollections: ['DEMO'] };
        case 'GetSceneList': return { scenes: this.scenes, currentProgramSceneName: 'Main output' };
        case 'GetInputList': return { inputs: this.inputs };
        case 'GetSceneItemList': return { sceneItems: data.sceneName === 'Main output' ? this.items.map(item => ({ ...item })) : [] };
        case 'SetSceneItemEnabled': {
          const item = this.items.find(item => item.sceneItemId === data.sceneItemId);
          if (!item || data.sceneName !== 'Main output') throw new Error('Demo item not found.');
          item.sceneItemEnabled = data.sceneItemEnabled;
          this.emit('event', { type: 'SceneItemEnableStateChanged', data }); return {};
        }
        case 'GetMediaInputStatus': return { mediaState: this.states[data.inputName] || 'OBS_MEDIA_STATE_STOPPED', mediaDuration: 180000, mediaCursor: 0 };
        case 'TriggerMediaInputAction': {
          const action = data.mediaAction.split('_').pop();
          this.states[data.inputName] = action === 'STOP' ? 'OBS_MEDIA_STATE_STOPPED' : action === 'PAUSE' ? 'OBS_MEDIA_STATE_PAUSED' : 'OBS_MEDIA_STATE_PLAYING';
          return {};
        }
        case 'GetSourceScreenshot': return { imageData: '' }; // Deliberately local placeholders; never fetch a customer image.
        default: throw new Error(`Demo does not implement ${type}.`);
      }
    }
  }
  root.DemoOBS = DemoOBS;
  if (typeof module !== 'undefined') module.exports = DemoOBS;
})(typeof window !== 'undefined' ? window : globalThis);
