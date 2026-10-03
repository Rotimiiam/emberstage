'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('camera dock page wires owned camera CSS and script only', () => {
  const html = read('camera_dock.html');
  assert.ok(html.includes('assets/css/camera_dock.css'));
  assert.ok(html.includes('assets/js/media/owned-camera-app.js'));
  assert.equal(html.includes('obs-client.js'), true);
  assert.ok(html.includes('native-camera-core.js'));
  assert.ok(html.includes('native-install.js'));
});

test('camera dock script parses and keeps camera-specific persisted controls', () => {
  const source = read('assets/js/media/owned-camera-app.js');
  assert.doesNotThrow(() => new vm.Script(source, { filename: 'owned-camera-app.js' }));
  assert.ok(source.includes("'emberstage-native-camera-ui-v1'"));
  assert.ok(source.includes("['cut', 'Cut']"));
  assert.ok(source.includes("['fade', 'Crossfade']"));
  assert.ok(source.includes("['dip', 'Dip to black']"));
  assert.ok(source.includes("['150', '300', '500']"));
  assert.ok(source.includes('InputCreated|InputRemoved|InputNameChanged'));
  assert.ok(source.includes('Selection never changes the output'));
  assert.ok(!source.includes('getUserMedia'));
  assert.ok(!source.includes('enumerateDevices'));
});

test('camera output script parses and uses transition helper with safe fallback', () => {
  const source = read('assets/js/outputs/camera-output.js');
  assert.doesNotThrow(() => new vm.Script(source, { filename: 'camera-output.js' }));
  assert.ok(source.includes('globalThis.EmberstageTransition'));
  assert.ok(source.includes('helper.create(output)'));
  assert.ok(source.includes("type: transitionType, duration: transitionDuration, fit: requestedFit"));
  assert.ok(source.includes('requestVideoFrameCallback'));
  assert.ok(source.includes("currentDeviceId === message.deviceId"));
  assert.ok(source.includes("reportStatus('switching'"));
  assert.ok(source.includes('Fade-style transitions may not work on drivers that refuse overlap'));
  assert.ok(source.includes('for (const stream of [...allStreams]) stopStream(stream)'));
});

test('camera dock stylesheet exists and stays compact-orientated', () => {
  const css = read('assets/css/camera_dock.css');
  assert.ok(css.includes('.camera-settings-panel'));
  assert.ok(css.includes('.camera-library.source-list'));
  assert.ok(css.includes('@media(max-width:480px)'));
  assert.ok(css.includes('@media(max-height:320px) and (min-width:481px)'));
});

test('camera discovery uses OBS input identities, never browser placeholders or capture', () => {
  const source = read('assets/js/media/owned-camera-app.js');
  assert.ok(source.includes('input.inputUuid'));
  assert.ok(source.includes('native.screenshot'));
  assert.ok(source.includes('NOT CONNECTED'));
  assert.ok(!source.includes('mediaDevices'));
  const save = source.match(/function save\(\) \{[\s\S]*?\n  \}/)[0];
  assert.ok(!save.includes('password.value'));
});

test('unified graphics only stacks media then text; cameras are native OBS scenes', () => {
  const html = read('emberstage_output.html');
  assert.ok(!html.includes('assets/js/outputs/camera-output.js'));
  assert.equal(html.includes('src="camera_output.html"'), false);
  assert.ok(html.indexOf('src="media_output.html"') < html.indexOf('src="browser_source.html"'));
  assert.ok(html.includes('allow="autoplay"'));
  assert.ok(html.includes('background: transparent'));
});

// Minimal dock DOM: exercises the actual startup/reconnect code without OBS,
// browser permissions, network requests, or real credentials.
function automaticDock({ protocol = 'file:', connectionScript = 'file:///fixture/Emberstage-private/obs-connection.js', fail = false, inputs = [], saved = {} } = {}) {
  const nodes = [], timers = new Map(), events = {}, stored = new Map(), channels = new Map();
  stored.set('emberstage-native-camera-ui-v1', JSON.stringify(saved));
  let id = 0, client, native, initialized = 0, loads = 0;
  const secret = 'synthetic-private-credential';
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.textContent = ''; this.isConnected = true; nodes.push(this); }
    append(...children) { this.children.push(...children); this.firstChild = this.children[0]; }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    addEventListener(name, fn) { (this.listeners ||= {})[name] = fn; }
    setAttribute(name, value) { this[name] = value; }
    get options() { return this.children; }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { top: 100, bottom: 300, width: 200, height: 200 }; }
    remove() {}
  }
  class Client {
    constructor() { client = this; this.calls = []; this.handlers = {}; }
    on(event, handler) { this.handlers[event] = handler; }
    async connect(config) {
      this.calls.push(config);
      if (fail) throw new Error(secret);
      this.ready = true;
    }
    disconnect() { this.ready = false; this.handlers.status?.({ state: 'disconnected' }); }
  }
  class Native {
    constructor() {
      native = this;
      this.calls = [];
      this.allInputs = inputs;
      this.inputs = inputs;
      this.live = false;
      this.activeLeftUuid = null;
      this.activeRightUuid = null;
      this.activeInputUuid = null;
    }
    async initialize() { initialized++; }
    async takeDual(left, right, options) {
      this.calls.push({ action: 'dual', left, right, ...options });
      this.live = true;
      this.dual = true;
      this.dualLayout = options.layout;
      this.dualCorner = options.corner;
      this.activeLeftUuid = left;
      this.activeRightUuid = right;
      this.currentFit = options.fit || 'cover';
    }
    async take(uuid, options = {}) {
      this.calls.push({ action: 'take', uuid, ...options });
      this.live = true;
      this.dual = false;
      this.activeInputUuid = uuid;
      this.activeLeftUuid = null;
      this.activeRightUuid = null;
      this.currentFit = options.fit || 'cover';
    }
    async hide(options) {
      this.calls.push({ action: 'hide', ...options });
      this.live = false;
      this.dual = false;
      this.activeLeftUuid = null;
      this.activeRightUuid = null;
    }
    async layout(options) {
      this.calls.push({ action: 'layout', ...options });
      this.currentPreset = options.preset;
      this.currentCorner = options.corner;
    }
    async screenshot(id) { (this.screenshots ||= []).push(id); if (this.failPreview) throw new Error('Temporary preview failure'); return `data:image/jpeg;base64,${Buffer.from(`frame-${this.screenshots.length}`).toString('base64')}`; }
    async refresh() {}
    dispose() {}
  }
  const app = new Node('main');
  const window = { innerHeight: 720, EmberstageNativeInstall: { connectionScript } };
  const context = vm.createContext({
    console,
    window, location: { protocol }, URL, OBSClient: Client, EmberstageNativeCamera: Native,
    document: {
      body: new Node('body'),
      getElementById: () => app, createElement: tag => new Node(tag), activeElement: null,
      head: { append(script) {
        loads++;
        window.EmberstageNativeConnection = { version: 1, port: 4455, password: secret };
        queueMicrotask(() => script.onload());
      } },
    },
    localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    BroadcastChannel: class { constructor(name) { channels.set(name,this); } postMessage() {} close() {} },
    setTimeout: (fn, delay) => { const key = ++id; timers.set(key, { fn, delay }); return key; },
    clearTimeout: key => timers.delete(key), setInterval: () => 1, clearInterval() {},
    addEventListener: (name, callback) => { events[name] = callback; },
  });
  vm.runInContext(read('assets/js/media/owned-camera-app.js'), context);
  return { client, native, window, document: context.document, stored, nodes, secret, events, timers, channels, get loads() { return loads; }, get initialized() { return initialized; } };
}
const dockTick = () => new Promise(resolve => setImmediate(resolve));
const retryTimers = dock => [...dock.timers].filter(([, timer]) => timer.delay !== 1200);

test('dual camera controls preview inset and swap, explicitly apply fade, and persist preferences', async () => {
  const inputs = ['a', 'b'].map(inputUuid => ({ inputUuid, inputName: inputUuid, inputKind: 'dshow_input' }));
  const dock = automaticDock({ inputs, saved: { transition: 'cut' } }); await dockTick();
  const sourceList = dock.nodes.find(node => node.className === 'source-list owned-library camera-library');
  const dualMenu = dock.nodes.find(node => node.className === 'camera-dual-popover');
  const dualMenuButton = dock.nodes.find(node => node['aria-label'] === 'Dual camera settings' && node.tag === 'button');
  assert.equal(dualMenu.hidden, true, 'dual settings start out of the camera source area');
  assert.equal(sourceList.children.length, 2, 'camera sources remain visible before opening settings');
  dualMenuButton.listeners.click();
  assert.equal(dualMenu.hidden, false, 'top-bar button opens the dual-camera popup');
  assert.equal(dualMenuButton['aria-expanded'], 'true');
  assert.equal(sourceList.children.length, 2, 'opening settings never replaces camera sources');
  const field = title => dock.nodes.find(node => node.tag === 'label' && node.children[0]?.textContent === title);
  const layout = field('Dual layout').children[1];
  const effect = field('Dual transition').children[1];
  assert.equal(effect.value, 'fade', 'old single-camera Cut default must not make dual cut silently');
  assert.equal(field('Small camera corner').hidden, true);
  layout.value = 'inset'; layout.listeners.change();
  assert.equal(field('Small camera corner').hidden, false);
  const left = field('Big camera').children[1], right = field('Small camera').children[1];
  dock.nodes.find(node => node.textContent === 'Swap cameras').listeners.click();
  assert.equal(left.value, 'b'); assert.equal(right.value, 'a');
  assert.equal(dock.native.calls.length, 0, 'editing settings and swapping are preview only');
  const apply = dock.nodes.find(node => node.textContent === 'Apply big + small');
  assert.equal(apply.disabled, false);
  apply.listeners.click(); await dockTick();
  assert.deepEqual(JSON.parse(JSON.stringify(dock.native.calls[0])), { action: 'dual', left: 'b', right: 'a', fit: 'cover', layout: 'inset', corner: 'bottom-right', transition: 'fade', duration: 300 });
  dock.nodes.find(node => node.textContent === 'Hide all').listeners.click(); await dockTick();
  assert.equal(dock.native.calls[1].transition, 'fade');
  effect.value = 'cut'; effect.listeners.change();
  const saved = JSON.parse(dock.stored.get('emberstage-native-camera-ui-v1'));
  assert.equal(saved.dualLayout, 'inset'); assert.equal(saved.dualTransition, 'cut');
  right.value = left.value; right.listeners.change();
  assert.equal(apply.disabled, true, 'same-camera pairs cannot apply');
  const reloaded = automaticDock({ inputs, saved }); await dockTick();
  assert.equal(reloaded.nodes.find(node => node.tag === 'label' && node.children[0]?.textContent === 'Dual transition').children[1].value, 'cut');
  assert.equal(reloaded.native.calls.length, 0, 'reload never publishes');
});

test('visible camera thumbnails refresh without selection, retain frames, and stop while hidden or disposed', async () => {
  const dock = automaticDock({ inputs: ['a','b'].map(inputUuid => ({ inputUuid, inputName: inputUuid, inputKind: 'dshow_input' })) });
  await dockTick();
  const poll = async () => { const [id, timer] = [...dock.timers].find(([,timer]) => timer.delay === 1200); dock.timers.delete(id); await timer.fn(); };
  await poll(); await poll();
  assert.deepEqual(dock.native.screenshots, ['a','b']);
  const list = dock.nodes.find(node => node.className === 'source-list owned-library camera-library');
  const image = list.children[0].children[0].firstChild;
  assert.equal(image.tag, 'img');
  const first = image.src;
  await poll(); assert.notEqual(image.src, first, 'frames update repeatedly without clicking');
  list.children[0].listeners.click();
  assert.equal(list.children[0].children[0].firstChild, image, 'render reuses the last decoded image');
  dock.native.failPreview = true; await poll(); await poll();
  assert.equal(list.children[0].children[0].firstChild, image, 'temporary errors do not blank the image');
  let count = dock.native.screenshots.length;
  await poll(); assert.equal(dock.native.screenshots.length,count,'failed inputs back off instead of hammering OBS');
  dock.document.hidden = true; await poll(); assert.equal(dock.native.screenshots.length,count);
  dock.document.hidden = false; dock.native.transitioning = true; await poll(); assert.equal(dock.native.screenshots.length,count);
  dock.events.pagehide();
  assert.equal([...dock.timers.values()].some(timer=>timer.delay === 1200),false);
});

test('full-screen media covers rather than disables single and dual cameras; Hide all remains authoritative', async () => {
  for (const layout of ['single','split','inset']) {
    const dock = automaticDock(); await dockTick();
    Object.assign(dock.native,{live:true,dual:layout!=='single',dualLayout:layout,activeInputUuid:'a',activeLeftUuid:'a',activeRightUuid:'b'});
    const send = async data => {
      dock.channels.get('emberstage-visual-v1').onmessage({data:{version:1,output:'media',...data}});
      for (const [id,timer] of [...dock.timers].filter(([,timer])=>timer.delay === 25)) {dock.timers.delete(id); timer.fn();}
      await dockTick();
    };
    await send({action:'active',layout:'full',transition:'fade',duration:300});
    assert.equal(dock.native.live,true,`${layout} camera remains underneath media`);
    await send({action:'inactive'});
    assert.equal(dock.native.live,true); assert.equal(dock.native.dualLayout,layout);
    assert.equal(dock.native.calls.length,0,'no hide/re-take cycle or source change');
    await send({action:'active',layout:'full'});
    dock.nodes.find(node=>node.textContent === 'Hide all').listeners.click(); await dockTick();
    await send({action:'inactive'});
    assert.equal(dock.native.live,false,'explicit camera Hide all is not undone when media disappears');
    assert.deepEqual(dock.native.calls.map(c=>c.action),['hide']);
    dock.events.pagehide();
  }
});

test('camera dock defaults to capture devices with a persisted All sources option', async () => {
  const inputs = ['dshow_input', 'macos-avcapture', 'v4l2_input', 'browser_source', 'ffmpeg_source', 'ndi_source', 'future_plugin', 'coreaudio_input_capture'].map((inputKind, index) => ({
    inputUuid: `input-${index}`, inputName: inputKind, inputKind
  }));
  const dock = automaticDock({ inputs }); await dockTick();
  const list = dock.nodes.find(node => node.className === 'source-list owned-library camera-library');
  assert.deepEqual(list.children.map(row => row.dataset.deviceId), inputs.slice(0, 3).map(input => input.inputUuid));
  const view = dock.nodes.find(node => node['aria-label'] === 'Source types');
  view.value = 'all'; view.listeners.change();
  assert.deepEqual(list.children.map(row => row.dataset.deviceId), inputs.map(input => input.inputUuid));
  const saved = JSON.parse(dock.stored.get('emberstage-native-camera-ui-v1'));
  assert.equal(saved.sourceView, 'all');
  const reloaded = automaticDock({ inputs, saved }); await dockTick();
  assert.equal(reloaded.nodes.find(node => node.className === 'source-list owned-library camera-library').children.length, inputs.length);
  view.value = 'capture'; view.listeners.change();
  assert.equal(list.children.length, 3);
  assert.equal(dock.nodes.some(node => node.textContent === 'Include source'), false);
  reloaded.events.pagehide();
  dock.events.pagehide();
});

test('installed camera dock automatically authenticates without a form or persistent browser secret', async () => {
  const dock = automaticDock(); await dockTick();
  assert.equal(dock.client.calls.length, 1);
  assert.equal(dock.client.calls[0].url, 'ws://127.0.0.1:4455');
  assert.equal(dock.client.calls[0].requireAuthentication, true);
  assert.equal(dock.client.calls[0].password, dock.secret);
  assert.equal(dock.initialized, 1);
  assert.equal('EmberstageNativeConnection' in dock.window, false);
  assert.equal(dock.nodes.some(node => node.type === 'password' || /^(Connect|Connect OBS)$/.test(node.textContent)), false);
  assert.equal(JSON.stringify([...dock.stored]).includes(dock.secret), false);
  assert.equal(retryTimers(dock).length, 0);
  dock.events.pagehide();
});

test('disconnect reloads private connection and reconnects automatically; pagehide cancels retries', async () => {
  const dock = automaticDock(); await dockTick(); dock.client.disconnect();
  assert.equal(retryTimers(dock).length, 1);
  const [id, retry] = retryTimers(dock)[0]; dock.timers.delete(id); retry.fn(); await dockTick();
  assert.equal(dock.loads, 2); assert.equal(dock.client.calls.length, 2);
  assert.equal(dock.initialized, 2); assert.equal(retryTimers(dock).length, 0);
  dock.client.disconnect(); dock.events.pagehide();
  assert.equal(dock.timers.size, 0);
});

test('reconnect preserves native layout and fullscreen media status keeps cameras covered instead of resetting layout', async () => {
  const inputs = [
    { inputUuid: 'cam-a', inputName: 'Camera A', inputKind: 'dshow_input' },
    { inputUuid: 'cam-b', inputName: 'Camera B', inputKind: 'dshow_input' }
  ];
  const dock = automaticDock({ inputs });
  await dockTick();

  dock.native.currentPreset = 'camera-inset';
  dock.native.currentCorner = 'top-left';
  dock.native.live = true;

  dock.client.disconnect();
  const [id, retry] = retryTimers(dock)[0];
  dock.timers.delete(id);
  retry.fn();
  await dockTick();

  const stage = dock.channels.get('emberstage-visual-v1');
  stage.onmessage({
    data: {
      version: 1,
      output: 'media',
      action: 'status',
      state: 'live',
      layout: { preset: 'full', corner: 'bottom-right' }
    }
  });
  await dockTick();

  const list = dock.nodes.find(node => node.className === 'source-list owned-library camera-library');
  list.children[0].listeners.click();
  const show = dock.nodes.find(node => node.tag === 'button' && node.textContent === 'Show camera');
  show.listeners.click();
  await dockTick();

  assert.equal(dock.native.currentPreset, 'camera-inset');
  assert.equal(dock.native.currentCorner, 'top-left');
  assert.equal(dock.native.calls.at(-1).action, 'take');
  dock.events.pagehide();
});

test('failed automatic authentication retries with bounded backoff and never displays secrets', async () => {
  const dock = automaticDock({ fail: true }); await dockTick();
  for (let i = 0; i < 8; i++) {
    assert.equal(retryTimers(dock).length, 1);
    const [id, retry] = retryTimers(dock)[0];
    assert.ok(retry.delay > 0 && retry.delay <= 10000);
    dock.timers.delete(id); retry.fn(); await dockTick();
  }
  assert.equal(dock.initialized, 0);
  assert.equal(dock.nodes.some(node => node.textContent.includes(dock.secret)), false);
  assert.equal(JSON.stringify([...dock.stored]).includes(dock.secret), false);
  dock.events.pagehide(); assert.equal(dock.timers.size, 0);
});

test('hosted docks and non-local private-script URLs cannot load installed credentials', async () => {
  for (const options of [{ protocol: 'https:' }, { connectionScript: 'https://example.test/Emberstage-private/obs-connection.js' }, { connectionScript: 'file://remote/Emberstage-private/obs-connection.js' }]) {
    const dock = automaticDock(options); await dockTick();
    assert.equal(dock.loads, 0); assert.equal(dock.client.calls.length, 0);
    dock.events.pagehide();
  }
});

test('media status object normalization and heartbeat layout persistence', async () => {
  const nodes = [];
  let stageOnMessage;
  let nativeLayoutCalled = [];
  let nativeHideCalled = [];

  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.textContent = ''; }
    append(...children) { this.children.push(...children); this.firstChild = this.children[0]; }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    addEventListener() {}
    setAttribute() {}
    querySelectorAll() { return []; }
    remove() {}
  }

  const app = new Node('main');
  const win = {
    EmberstageNativeInstall: {
      connectionScript: 'file:///fixture/Emberstage-private/obs-connection.js'
    }
  };

  const context = vm.createContext({
    console,
    window: win,
    location: { protocol: 'file:' },
    URL,
    OBSClient: class {
      constructor() { this.ready = true; }
      on() {}
      async connect() {}
    },
    EmberstageNativeCamera: class {
      constructor() {
        this.allInputs = [];
        this.inputs = [];
        this.live = true;
        this.transitioning = false;
      }
      async initialize() {}
      async layout(opts) {
        nativeLayoutCalled.push(opts);
      }
      async hide(opts) {
        nativeHideCalled.push(opts);
      }
      dispose() {}
    },
    document: {
      body: new Node('body'),
      getElementById: () => app,
      createElement: tag => new Node(tag),
      activeElement: null,
      head: {
        append(script) {
          win.EmberstageNativeConnection = { version: 1, port: 4455, password: 'password' };
          if (script.onload) script.onload();
        }
      }
    },
    localStorage: {
      getItem: (key) => {
        if (key === 'emberstage-native-camera-ui-v1') {
          return JSON.stringify({ transition: 'fade', duration: 300 });
        }
        return null;
      },
      setItem: () => {}
    },
    BroadcastChannel: class {
      constructor(name) {
        this.name = name;
      }
      set onmessage(fn) {
        if (this.name === 'emberstage-visual-v1') {
          stageOnMessage = fn;
        }
      }
      postMessage() {}
      close() {}
    },
    setTimeout: (fn, delay) => {
      if (delay === 25) {
        queueMicrotask(fn);
      }
      return 1;
    },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener: () => {}
  });

  vm.runInContext(read('assets/js/media/owned-camera-app.js'), context);

  // Await the connection setup to complete
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.ok(stageOnMessage, 'stage.onmessage should be registered');

  // Trigger status heartbeat with layout OBJECT {preset, corner}
  stageOnMessage({
    data: {
      version: 1,
      output: 'media',
      action: 'status',
      state: 'live',
      layout: { preset: 'camera-inset', corner: 'top-left' }
    }
  });

  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(nativeLayoutCalled.length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(nativeLayoutCalled[0])), {
    preset: 'camera-inset',
    corner: 'top-left',
    transition: 'fade',
    duration: 300,
    isExplicit: false
  });

  // Fullscreen media should not forcibly reset the current camera layout because
  // cameras remain covered underneath full media and should restore as-is later.
  nativeLayoutCalled = [];
  stageOnMessage({
    data: {
      version: 1,
      output: 'media',
      action: 'status',
      state: 'live',
      layout: 'full',
      corner: 'bottom-right'
    }
  });

  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(nativeLayoutCalled.length, 0);
});

test('dual camera Apply button toggle (unapply) behavior and label accuracy', async () => {
  const inputs = [
    { inputUuid: 'cam-a', inputName: 'Camera A', inputKind: 'dshow_input' },
    { inputUuid: 'cam-b', inputName: 'Camera B', inputKind: 'dshow_input' },
    { inputUuid: 'cam-c', inputName: 'Camera C', inputKind: 'dshow_input' }
  ];
  
  const dock = automaticDock({ inputs, saved: { dualLayout: 'split' } });
  await dockTick();
  
  const field = title => dock.nodes.find(node => node.tag === 'label' && node.children[0]?.textContent === title);
  const left = field('Left Camera').children[1];
  const right = field('Right Camera').children[1];
  const framing = field('Framing').children[1];
  const applyBtn = dock.nodes.find(node => node.tag === 'button' && (node.textContent.includes('Apply') || node.textContent.includes('Unapply')));
  
  assert.equal(applyBtn.textContent, 'Apply 50/50');
  assert.equal(applyBtn['aria-pressed'], 'false');
  
  left.value = 'cam-a';
  right.value = 'cam-b';
  left.listeners.change();
  right.listeners.change();
  await dockTick();
  
  applyBtn.listeners.click();
  await dockTick();
  
  assert.equal(dock.native.dual, true);
  assert.equal(dock.native.activeLeftUuid, 'cam-a');
  assert.equal(dock.native.activeRightUuid, 'cam-b');
  assert.equal(dock.native.currentFit, 'cover');
  
  assert.equal(applyBtn.textContent, 'Unapply 50/50');
  assert.equal(applyBtn['aria-pressed'], 'true');
  
  framing.value = 'contain';
  framing.listeners.change();
  await dockTick();
  
  assert.equal(applyBtn.textContent, 'Apply 50/50');
  assert.equal(applyBtn['aria-pressed'], 'false');
  
  applyBtn.listeners.click();
  await dockTick();
  
  assert.equal(dock.native.dual, true);
  assert.equal(dock.native.currentFit, 'contain');
  assert.equal(applyBtn.textContent, 'Unapply 50/50');
  assert.equal(applyBtn['aria-pressed'], 'true');
  
  applyBtn.listeners.click();
  await dockTick();
  
  assert.equal(dock.native.dual, false);
  assert.equal(dock.native.activeInputUuid, 'cam-a');
  assert.equal(dock.native.calls[dock.native.calls.length - 1].action, 'take');
  assert.equal(dock.native.calls[dock.native.calls.length - 1].uuid, 'cam-a');
  
  dock.native.activeInputUuid = 'cam-c';
  dock.native.dual = false;
  await dockTick();
  
  left.value = 'cam-a';
  right.value = 'cam-b';
  framing.value = 'contain';
  applyBtn.listeners.click();
  await dockTick();
  
  assert.equal(dock.native.dual, true);
  assert.equal(applyBtn.textContent, 'Unapply 50/50');
  assert.equal(applyBtn['aria-pressed'], 'true');
  
  applyBtn.listeners.click();
  await dockTick();
  
  assert.equal(dock.native.dual, false);
  assert.equal(dock.native.activeInputUuid, 'cam-c');
  assert.equal(dock.native.calls[dock.native.calls.length - 1].action, 'take');
  assert.equal(dock.native.calls[dock.native.calls.length - 1].uuid, 'cam-c');
  
  left.value = 'cam-a';
  right.value = 'cam-b';
  applyBtn.listeners.click();
  await dockTick();
  assert.equal(applyBtn.textContent, 'Unapply 50/50');
  
  const originalTake = dock.native.take;
  let takeCalledCount = 0;
  dock.native.take = async (uuid, options) => {
    takeCalledCount++;
    throw new Error('Simulated take error');
  };
  
  applyBtn.listeners.click();
  await dockTick();
  
  assert.equal(takeCalledCount, 1);
  dock.native.take = originalTake;
  
  assert.equal(dock.native.dual, true);
  assert.equal(applyBtn.textContent, 'Unapply 50/50');
  assert.equal(applyBtn['aria-pressed'], 'true');
  
  dock.events.pagehide();
});

test('regression: camera originally in slot B/after media inset, repeated dual changes/refresh, missing prior input failures, media layout after unapply', async () => {
  const inputs = [
    { inputUuid: 'cam-a', inputName: 'Camera A', inputKind: 'dshow_input' },
    { inputUuid: 'cam-b', inputName: 'Camera B', inputKind: 'dshow_input' },
    { inputUuid: 'cam-c', inputName: 'Camera C', inputKind: 'dshow_input' }
  ];

  const sendLayout = async (targetDock, data) => {
    const channel = targetDock.channels.get('emberstage-visual-v1');
    channel.onmessage({
      data: { version: 1, output: 'media', ...data }
    });
    for (const [id, timer] of [...targetDock.timers].filter(([, timer]) => timer.delay === 25)) {
      targetDock.timers.delete(id);
      timer.fn();
    }
    await dockTick();
    await dockTick();
    await dockTick();
  };

  // 1. Setup dock with a single active camera cam-b (to simulate "originally in slot B")
  const dock = automaticDock({ inputs, saved: { dualLayout: 'split' } });
  const stateBadge = dock.nodes.find(node => node.tag === 'span' && node.className.includes('badge'));
  while (!stateBadge.className.includes('on')) {
    await dockTick();
  }

  const field = title => dock.nodes.find(node => node.tag === 'label' && node.children[0]?.textContent === title);
  const left = field('Left Camera').children[1];
  const right = field('Right Camera').children[1];
  const applyBtn = dock.nodes.find(node => node.tag === 'button' && (node.textContent.includes('Apply') || node.textContent.includes('Unapply')));

  // Simulating single camera 'cam-b' being active/selected
  dock.native.activeInputUuid = 'cam-b';
  dock.native.currentFit = 'contain';
  dock.native.live = true;
  await dockTick();

  // 2. Media layout inset applied
  await sendLayout(dock, {
    action: 'layout-change',
    preset: 'camera-inset',
    corner: 'bottom-right'
  });

  // 3. Apply dual camera ('cam-a' and 'cam-c')
  left.value = 'cam-a';
  right.value = 'cam-c';
  left.listeners.change();
  right.listeners.change();
  await dockTick();

  applyBtn.listeners.click();
  await dockTick();

  assert.equal(dock.native.dual, true);

  // 4. Repeated dual changes: change layout split to inset, then apply again
  const dualLayout = field('Dual layout').children[1];
  dualLayout.value = 'inset';
  dualLayout.listeners.change();
  await dockTick();

  applyBtn.listeners.click();
  await dockTick();

  // Verify dual is still true, and preDual values were NOT lost or overwritten
  assert.equal(dock.native.dual, true);
  const savedState = JSON.parse(dock.stored.get('emberstage-native-camera-ui-v1') || '{}');
  assert.equal(savedState.preDualCameraUuid, 'cam-b');
  assert.equal(savedState.preDualFit, 'contain');

  // 5. Refresh/reload simulation
  const reloadedDock = automaticDock({ inputs, saved: savedState });
  const reloadedStateBadge = reloadedDock.nodes.find(node => node.tag === 'span' && node.className.includes('badge'));
  while (!reloadedStateBadge.className.includes('on')) {
    await dockTick();
  }

  const reloadedApplyBtn = reloadedDock.nodes.find(node => node.tag === 'button' && (node.textContent.includes('Apply') || node.textContent.includes('Unapply')));
  const reloadedField = title => reloadedDock.nodes.find(node => node.tag === 'label' && node.children[0]?.textContent === title);
  const reloadedLeft = reloadedField('Big camera').children[1];
  const reloadedRight = reloadedField('Small camera').children[1];
  reloadedLeft.value = 'cam-a';
  reloadedRight.value = 'cam-c';
  reloadedLeft.listeners.change();
  reloadedRight.listeners.change();
  await dockTick();

  // Simulate that the active dual camera is live in the reloaded dock
  reloadedDock.native.dual = true;
  reloadedDock.native.live = true;
  reloadedDock.native.dualLayout = 'inset';
  reloadedDock.native.dualCorner = 'bottom-right';
  reloadedDock.native.currentFit = 'cover';
  reloadedDock.native.activeLeftUuid = 'cam-a';
  reloadedDock.native.activeRightUuid = 'cam-c';
  await dockTick();

  // 6. Missing prior input failure test: remove cam-b and click Unapply
  const inputsWithoutB = [
    { inputUuid: 'cam-a', inputName: 'Camera A', inputKind: 'dshow_input' },
    { inputUuid: 'cam-c', inputName: 'Camera C', inputKind: 'dshow_input' }
  ];
  reloadedDock.native.allInputs = inputsWithoutB;
  reloadedDock.native.inputs = inputsWithoutB;
  await dockTick();

  reloadedApplyBtn.listeners.click();
  await dockTick();

  // Verify that it failed and dual-camera is still active
  assert.equal(reloadedDock.native.dual, true);
  const reloadedNotice = reloadedDock.nodes.find(node => node.tag === 'div' && node.className === 'notice');
  assert.equal(reloadedNotice.textContent, 'The prior single camera is no longer available.');

  // Restore cam-b
  reloadedDock.native.allInputs = inputs;
  reloadedDock.native.inputs = inputs;
  await dockTick();

  // Simulate that media layout changed while dual was active (e.g. media was superseded/inactive)
  await sendLayout(reloadedDock, {
    action: 'inactive'
  });

  // Unapply
  reloadedApplyBtn.listeners.click();
  await dockTick();

  // Verify single camera 'cam-b' is restored
  assert.equal(reloadedDock.native.dual, false);
  assert.equal(reloadedDock.native.activeInputUuid, 'cam-b');
  assert.equal(reloadedDock.native.currentFit, 'contain');

  // Verify media layout after unapply: because media was superseded (inactive), preset should be 'full'
  assert.equal(reloadedDock.native.currentPreset, 'full');

  dock.events.pagehide();
  reloadedDock.events.pagehide();
});
