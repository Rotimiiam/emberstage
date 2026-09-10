'use strict';
// Run with: node --test tests/media-deck.test.cjs
// Entirely local; no OBS process, server, package install, or real WebSocket.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const OBSClient = require('../assets/js/media/obs-client.js');
const Media = require('../assets/js/media/media-core.js');
const DemoOBS = require('../assets/js/media/demo.js');
const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
const hash = value => createHash('sha256').update(value).digest('base64');
const mutations = calls => calls.filter(call => /^(Set|Trigger|Create|Remove)/.test(call.type));

class FakeWebSocket {
  static sockets = [];
  constructor(url) { this.url = url; this.sent = []; this.closed = false; FakeWebSocket.sockets.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.closed = true; }
  async receive(op, d) { await this.onmessage?.({ data: JSON.stringify({ op, d }) }); }
  reply(request, data = {}, result = true) {
    return this.receive(7, { requestId: request.d.requestId, requestStatus: { result, code: result ? 100 : 600 }, responseData: data });
  }
}
async function identified(options = {}) {
  const client = new OBSClient({ WebSocket: FakeWebSocket, crypto: webcrypto, timeout: 1000, ...options });
  const pending = client.connect(); const socket = FakeWebSocket.sockets.at(-1);
  await socket.receive(0, { rpcVersion: 1 }); await socket.receive(2, { negotiatedRpcVersion: 1 }); await pending;
  return { client, socket };
}

test('OBS class is exported to window without opening a socket', () => {
  const context = vm.createContext({ window: {}, URL, TextEncoder, btoa, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/js/media/obs-client.js'), 'utf8'), context);
  assert.equal(typeof context.window.OBSClient, 'function');
  const client = new context.window.OBSClient({ WebSocket: FakeWebSocket });
  assert.equal(client.ready, false); assert.equal(client.socket, undefined);
});

test('v5 challenge authentication sends the correct SHA-256/base64 response; connect is not a live action', async () => {
  const client = new OBSClient({ WebSocket: FakeWebSocket, crypto: webcrypto });
  const observed = []; client.on('status', event => observed.push(event));
  const pending = client.connect({ password: 'test-only-not-a-secret' }); const socket = FakeWebSocket.sockets.at(-1);
  await socket.receive(0, { rpcVersion: 1, authentication: { salt: 'fixture-salt', challenge: 'fixture-challenge' } });
  assert.equal(socket.sent.length, 1); assert.equal(socket.sent[0].op, 1);
  assert.equal(socket.sent[0].d.authentication, hash(hash('test-only-not-a-secretfixture-salt') + 'fixture-challenge'));
  assert.equal(socket.sent[0].d.rpcVersion, 1); assert.equal(client.ready, false);
  await socket.receive(2, { negotiatedRpcVersion: 1 }); await pending;
  assert.equal(client.ready, true); assert.equal(socket.sent.some(packet => packet.op === 6), false);
  assert.equal(JSON.stringify(observed).includes('test-only'), false); assert.equal('password' in client, false);
  client.disconnect();
});

test('requestId correlates out-of-order replies and failure rejects', async () => {
  const { client, socket } = await identified();
  const first = client.request('GetSceneList'); const second = client.request('GetInputList');
  const [a, b] = socket.sent.filter(packet => packet.op === 6);
  assert.notEqual(a.d.requestId, b.d.requestId);
  await socket.reply(b, { inputs: ['b'] }); await socket.reply(a, { scenes: ['a'] });
  assert.deepEqual(await first, { scenes: ['a'] }); assert.deepEqual(await second, { inputs: ['b'] });
  const failed = client.request('GetSceneItemList'); const rejection = assert.rejects(failed, /OBS 600/);
  await socket.reply(socket.sent.at(-1), {}, false); await rejection; client.disconnect();
});

test('timeouts remove pending requests and ignore late responses', async () => {
  const { client, socket } = await identified({ timeout: 20 });
  await assert.rejects(client.request('GetSceneList'), /timed out/);
  assert.equal(client.pending.size, 0); await socket.reply(socket.sent.at(-1), {}); client.disconnect();
});

test('disconnect rejects pending requests; explicit reconnect sends only Identify', async () => {
  const { client, socket } = await identified(); const request = client.request('GetSceneList');
  const rejected = assert.rejects(request, /Disconnected/); client.disconnect(); await rejected;
  assert.equal(client.pending.size, 0); assert.equal(socket.closed, true);
  const connect = client.connect(); const replacement = FakeWebSocket.sockets.at(-1);
  await replacement.receive(0, {}); await replacement.receive(2, {}); await connect;
  assert.deepEqual(replacement.sent.map(packet => packet.op), [1]); client.disconnect();
});

test('authentication close provides an actionable error and never echoes the password', async () => {
  const client = new OBSClient({ WebSocket: FakeWebSocket });
  const connecting = client.connect({ password: 'do-not-echo' }); const rejected = assert.rejects(connecting, /authentication failed/);
  FakeWebSocket.sockets.at(-1).onclose({ code: 4009, reason: 'do-not-echo' }); await rejected;
  assert.equal(client.ready, false); assert.equal(client.socket, null);
});

test('remote plaintext and credential-bearing URLs are refused before WebSocket creation', async () => {
  const client = new OBSClient({ WebSocket: FakeWebSocket }); const count = FakeWebSocket.sockets.length;
  for (const url of ['ws://example.com:4455', 'ws://user:pass@localhost:4455', 'ws://localhost:4455?password=test', 'https://localhost:4455']) {
    await assert.rejects(client.connect({ url }), /Use /);
  }
  assert.equal(FakeWebSocket.sockets.length, count);
  const pending = client.connect({ url: 'wss://example.com:4455', allowRemote: true });
  const socket = FakeWebSocket.sockets.at(-1); await socket.receive(0, {}); await socket.receive(2, {}); await pending; client.disconnect();
});

test('op5 events dispatch the event type and sanitized status, without triggering requests', async () => {
  const { client, socket } = await identified(); const events = [];
  client.on('SceneItemEnableStateChanged', event => events.push(event));
  const before = socket.sent.length;
  await socket.receive(5, { eventType: 'SceneItemEnableStateChanged', eventData: { sceneItemId: 7, sceneItemEnabled: true } });
  assert.deepEqual(events, [{ sceneItemId: 7, sceneItemEnabled: true }]); assert.equal(socket.sent.length, before); client.disconnect();
});

function memoryStorage() {
  const data = new Map(); return { data, getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
}
async function fixture({ review = true } = {}) {
  const client = new DemoOBS(); const storage = memoryStorage(); const settings = new Media.Settings({ storage, demo: true });
  const deck = new Media.Deck(client, settings);
  await client.connect(); await deck.refresh(); deck.chooseScene(deck.scenes[0]); await deck.refresh();
  if (review) { const choices = {}; for (const item of deck.items) choices[deck.key(item)] = Media.classify(item.inputKind); deck.review(choices); }
  return { client, settings, deck, storage };
}

test('explicit demo has five cameras, 24 pictures and four media inputs without touching storage', async () => {
  const { client, deck, storage } = await fixture();
  assert.equal(deck.items.filter(item => deck.category(item) === 'cameras').length, 5);
  assert.equal(deck.items.filter(item => deck.category(item) === 'pictures').length, 24);
  assert.equal(deck.items.filter(item => deck.category(item) === 'videos').length, 4);
  assert.equal(storage.data.size, 0); assert.equal(mutations(client.calls).length, 0);
});

test('connect, refresh, choose scene, review and local selection never mutate OBS', async () => {
  const { client, deck } = await fixture();
  deck.select(deck.key(deck.items[3])); assert.equal(deck.selected().sourceName, 'Camera 04');
  assert.equal(mutations(client.calls).length, 0);
  deck.chooseScene(deck.scenes[1]); await deck.refresh(); assert.equal(deck.items.length, 0);
  assert.equal(mutations(client.calls).length, 0);
});

test('unreviewed input cannot be taken, even if its kind is recognized', async () => {
  const { client, deck } = await fixture({ review: false });
  await assert.rejects(deck.visibility(deck.key(deck.items[1]), true, true), /Review and include/);
  assert.equal(mutations(client.calls).length, 0);
});

test('camera Take changes only reviewed camera peers, preserving picture and text layers', async () => {
  const { client, deck } = await fixture();
  client.items.find(item => item.inputKind === 'image_source').sceneItemEnabled = true;
  client.items.find(item => item.inputKind === 'browser_source').sceneItemEnabled = true;
  await deck.visibility(deck.key(deck.items[1]), true, true);
  const writes = mutations(client.calls);
  assert.deepEqual(writes.map(call => call.data.sceneItemId), [2, 1]);
  assert.equal(writes.every(call => call.type === 'SetSceneItemEnabled' && call.data.sceneName === 'Main output'), true);
  assert.equal(client.items[1].sceneItemEnabled, true); assert.equal(client.items[0].sceneItemEnabled, false);
  assert.equal(client.items.find(item => item.inputKind === 'image_source').sceneItemEnabled, true);
  assert.equal(client.items.find(item => item.inputKind === 'browser_source').sceneItemEnabled, true);
  assert.equal(deck.items[1].sceneItemEnabled, true);
});

test('picture Show defaults to non-exclusive; Hide targets only selected item', async () => {
  const { client, deck } = await fixture(); const pictures = deck.items.filter(item => deck.category(item) === 'pictures');
  await deck.visibility(deck.key(pictures[0]), true); await deck.visibility(deck.key(pictures[1]), true);
  assert.equal(client.items.find(item => item.sceneItemId === pictures[0].sceneItemId).sceneItemEnabled, true);
  assert.equal(client.items.find(item => item.sceneItemId === pictures[1].sceneItemId).sceneItemEnabled, true);
  await deck.visibility(deck.key(pictures[1]), false);
  assert.equal(client.items.find(item => item.sceneItemId === pictures[0].sceneItemId).sceneItemEnabled, true);
  assert.equal(client.items.find(item => item.sceneItemId === pictures[1].sceneItemId).sceneItemEnabled, false);
});

test('exclusive pictures preserve excluded logos and camera visibility', async () => {
  const { client, deck } = await fixture(); const pictures = deck.items.filter(item => deck.category(item) === 'pictures');
  deck.review({ [deck.key(pictures[0])]: 'excluded' });
  client.items.find(item => item.sceneItemId === pictures[0].sceneItemId).sceneItemEnabled = true;
  client.items.find(item => item.sceneItemId === pictures[1].sceneItemId).sceneItemEnabled = true;
  await deck.visibility(deck.key(pictures[2]), true, true);
  assert.equal(client.items.find(item => item.sceneItemId === pictures[0].sceneItemId).sceneItemEnabled, true);
  assert.equal(client.items.find(item => item.sceneItemId === pictures[1].sceneItemId).sceneItemEnabled, false);
  assert.equal(client.items[0].sceneItemEnabled, true);
});

test('source identity is revalidated before mutation; reused item IDs require a new review', async () => {
  const { client, deck } = await fixture(); const key = deck.key(deck.items[1]);
  client.items[1].sourceUuid = 'replacement-input';
  await assert.rejects(deck.visibility(key, true, true), /identity changed/);
  assert.equal(mutations(client.calls).length, 0);
});

test('scene-collection changes invalidate the selected output and its mappings', async () => {
  const { client, deck } = await fixture(); const key = deck.key(deck.items[1]); const request = client.request.bind(client);
  client.request = (type, data) => type === 'GetSceneCollectionList' ? Promise.resolve({ currentSceneCollectionName: 'Different collection' }) : request(type, data);
  await assert.rejects(deck.visibility(key, true, true), /identity changed/); assert.equal(mutations(client.calls).length, 0);
});

test('transport is native ffmpeg/vlc only and reads actual OBS status after action', async () => {
  const { client, deck } = await fixture();
  await assert.rejects(deck.transport(deck.key(deck.items[0]), 'PLAY'), /only for OBS Media Source/);
  const video = deck.items.find(item => item.inputKind === 'ffmpeg_source');
  const status = await deck.transport(deck.key(video), 'PLAY');
  assert.equal(status.mediaState, 'OBS_MEDIA_STATE_PLAYING');
  const write = mutations(client.calls).at(-1);
  assert.deepEqual(write, { type: 'TriggerMediaInputAction', data: { inputName: video.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' } });
  assert.equal(client.calls.at(-1).type, 'GetMediaInputStatus');
  await assert.rejects(deck.transport(deck.key(video), 'MADE_UP'), /Unsupported/);
});

test('type classification uses actual inputKind IDs, never source display names', () => {
  for (const kind of ['dshow_input', 'av_capture_input', 'av_capture_input_v2', 'v4l2_input', 'decklink-input']) assert.equal(Media.classify(kind), 'cameras');
  for (const kind of ['image_source', 'slideshow']) assert.equal(Media.classify(kind), 'pictures');
  for (const kind of ['ffmpeg_source', 'vlc_source']) assert.equal(Media.classify(kind), 'videos');
  for (const kind of ['Camera 1', 'image', 'browser_source', 'window_capture', 'unknown_plugin']) assert.equal(Media.classify(kind), 'excluded');
});

function nestedClient({ hidden = false, repeated = false, nestedScene = false } = {}) {
  const calls = [];
  const group = { sceneItemId: 10, sourceName: 'Container', sourceUuid: 'group-uuid', isGroup: !nestedScene, sourceType: 'OBS_SOURCE_TYPE_SCENE', sceneItemEnabled: !hidden };
  const leaf = { sceneItemId: 7, sourceName: '<b>My image</b>', sourceUuid: 'image-uuid', inputKind: 'image_source', sceneItemEnabled: false };
  const client = { ready: true, calls, on() {}, async request(type, data = {}) {
    calls.push({ type, data });
    if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Collection A' };
    if (type === 'GetSceneList') return { scenes: [{ sceneName: 'Output', sceneUuid: 'output-uuid' }], currentProgramSceneName: 'Output' };
    if (type === 'GetInputList') return { inputs: [{ inputName: leaf.sourceName, inputKind: leaf.inputKind, inputUuid: leaf.sourceUuid }] };
    if (type === 'GetSceneItemList' && data.sceneName === 'Output') return { sceneItems: repeated ? [group, { ...group, sceneItemId: 11 }] : [group] };
    if (['GetSceneItemList', 'GetGroupSceneItemList'].includes(type) && data.sceneName === 'Container') return { sceneItems: [{ ...leaf }] };
    if (type === 'SetSceneItemEnabled') { assert.equal(data.sceneName, 'Container'); assert.equal(data.sceneItemId, 7); leaf.sceneItemEnabled = data.sceneItemEnabled; return {}; }
    throw new Error(`Unexpected fixture call ${type}`);
  } };
  return client;
}
async function nestedDeck(options) {
  const client = nestedClient(options); const settings = new Media.Settings({ demo: true }); const deck = new Media.Deck(client, settings);
  await deck.refresh(); deck.chooseScene(deck.scenes[0]); await deck.refresh();
  deck.review({ [deck.key(deck.items[0])]: 'pictures' }); return { client, deck };
}

test('nested groups preserve owner container, item ID and path when showing a leaf', async () => {
  const { client, deck } = await nestedDeck(); const item = deck.items[0];
  assert.equal(item.ownerSceneName, 'Container'); assert.equal(item.sceneItemId, 7);
  assert.deepEqual(item.path, ['Container', '<b>My image</b>']);
  assert.deepEqual(JSON.parse(deck.key(item)), ['Collection A', 'output-uuid', 'group-uuid', 7]);
  await deck.visibility(deck.key(item), true);
  assert.deepEqual(mutations(client.calls).map(call => call.data), [{ sceneName: 'Container', sceneItemId: 7, sceneItemEnabled: true }]);
});

test('hidden groups, repeated containers, and nested scenes are blocked without mutations', async () => {
  for (const options of [{ hidden: true }, { repeated: true }, { nestedScene: true }]) {
    const { client, deck } = await nestedDeck(options);
    assert.equal(deck.items.length, 1); assert.ok(deck.items[0].blocked);
    await assert.rejects(deck.visibility(deck.key(deck.items[0]), true)); assert.equal(mutations(client.calls).length, 0);
  }
});

test('recursive scene inventory has a cycle guard', async () => {
  let calls = 0;
  const client = { async request() { calls++; return { sceneItems: [{ sourceName: 'Loop', sourceType: 'OBS_SOURCE_TYPE_SCENE', sceneItemId: 1 }] }; } };
  const result = await Media.inventory(client, { sceneName: 'Loop' }, []);
  assert.equal(calls, 1); assert.equal(result.items.length, 0); assert.ok(result.warnings.length);
});

test('shared settings storage events sync the chosen scene, never the current program or passwords', () => {
  const storage = memoryStorage(); const events = { addEventListener(name, callback) { this[name] = callback; } };
  const first = new Media.Settings({ storage }); const second = new Media.Settings({ storage, events }); let notified = 0; second.on(() => notified++);
  first.update({ target: { collection: 'A', sceneName: 'Output', sceneUuid: 'id' }, password: 'not-exported' });
  events.storage({ key: Media.SETTINGS_KEY }); assert.equal(second.value.target.sceneName, 'Output'); assert.equal(notified, 1);
  assert.equal(first.export().includes('not-exported'), false); assert.equal(storage.getItem(Media.SETTINGS_KEY).includes('password'), false);
  first.update({ url: 'ws://name:secret@localhost:4455' }); assert.equal(first.export().includes('secret'), false);
});

test('thumbnail queue stays at two requests, 240px, caches successes, and resolves failures', async () => {
  const requests = []; let active = 0, peak = 0;
  const client = { request(type, data) { active++; peak = Math.max(peak, active); return new Promise((resolve, reject) => requests.push({ type, data, resolve(value) { active--; resolve(value); }, reject() { active--; reject(new Error('offline')); } })); } };
  const shots = new Media.Screenshots(client); const first = shots.get('A'); const second = shots.get('B'); const third = shots.get('C');
  assert.equal(requests.length, 2); assert.strictEqual(shots.get('A'), first);
  assert.ok(requests.every(request => request.type === 'GetSourceScreenshot' && request.data.imageWidth === 240));
  requests[0].resolve({ imageData: 'data:image/png;base64,AA==' }); await tick();
  assert.equal(requests.length, 3); requests[1].reject(); requests[2].resolve({ imageData: 'javascript:alert(1)' });
  assert.deepEqual(await Promise.all([first, second, third]), ['data:image/png;base64,AA==', null, null]); assert.equal(peak, 2);
});

function controlContext(dock, sharedTab = 'text') {
  const handlers = {}; const writes = []; const clicks = [];
  const classList = () => ({ add() {}, remove() {}, toggle() {} });
  const tabs = ['text', 'bibleText', 'songs', 'setBg'].map(value => ({ value, classList: classList(), setAttribute() {}, addEventListener() {} }));
  const areas = new Map(tabs.map(tab => [tab.value, { style: {}, classList: classList() }]));
  const doc = { body: { dataset: {}, classList: classList(), style: { setProperty() {} } },
    getElementsByClassName(name) { return name === 'tab-button' ? tabs : name === 'tab-area' ? [...areas.values()] : []; },
    getElementById(id) { return areas.get(id) || { click() { clicks.push(id); }, style: {} }; },
    addEventListener(name, callback) { handlers[name] = callback; } };
  const window = { location: { search: `?dock=${dock}` }, addEventListener() {} };
  const context = vm.createContext({ window, document: doc, URLSearchParams, localStorage: { getItem() { return sharedTab; }, setItem(key, value) { writes.push([key, value]); } } });
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/js/control_panel/control_app.js'), 'utf8'), context);
  return { context, window, handlers, writes, clicks, tabs };
}

test('standalone Scripture and Songs keep their own active view and never write shared selectedTab', () => {
  for (const [dock, tab, other] of [['scripture', 'bibleText', 'songs'], ['songs', 'songs', 'bibleText']]) {
    const instance = controlContext(dock, other); instance.context.openTab(tab);
    assert.equal(instance.window.getActiveControlTab(), tab); assert.equal(instance.writes.length, 0);
    instance.context.openTab(other); assert.equal(instance.window.getActiveControlTab(), tab);
    instance.context.openTab('setBg'); assert.equal(instance.window.getActiveControlTab(), 'setBg');
    assert.equal(instance.tabs.find(button => button.value === other).hidden, true);
  }
});

test('standalone key routing uses local view instead of cross-dock selectedTab and respects editable fields', () => {
  const scripture = controlContext('scripture', 'songs');
  const event = key => ({ key, target: { closest() { return null; } }, preventDefault() {}, stopImmediatePropagation() {} });
  scripture.handlers.keydown(event('ArrowRight')); assert.deepEqual(scripture.clicks, ['next-verse']);
  scripture.handlers.keydown({ ...event('ArrowRight'), target: { closest() { return {}; } } }); assert.equal(scripture.clicks.length, 1);
  const songs = controlContext('songs', 'bibleText'); songs.handlers.keydown(event('ArrowDown')); assert.deepEqual(songs.clicks, ['next-line']);
  songs.context.openTab('setBg'); songs.handlers.keydown(event('ArrowDown')); assert.equal(songs.clicks.length, 1);
});

test('entry pages use local media scripts, no protected OBS scripts, and contain valid local asset references', () => {
  for (const filename of ['video_mixer.html', 'picture_picker.html', 'media_dock.html', 'camera_dock.html', 'media_setup.html']) {
    const html = fs.readFileSync(path.join(root, filename), 'utf8');
    assert.ok(html.includes('name="viewport"')); assert.ok(html.includes('id="media-app"'));
    assert.equal(html.includes('assets/js/obs/'), false);
    for (const match of html.matchAll(/(?:src|href)="(assets\/[^"?#]+)"/g)) assert.ok(fs.existsSync(path.join(root, match[1])), `${filename}: ${match[1]}`);
  }
  const control = fs.readFileSync(path.join(root, 'control_panel.html'), 'utf8');
  assert.equal(/Omo To Mo|Amazing Grace|10,000 Reasons|In Christ Alone/.test(control), false);
  assert.ok(control.includes('<title>Text · Emberstage for OBS</title>'));
  assert.ok(control.includes('<span>Take text</span>'));
  const ui = fs.readFileSync(path.join(root, 'assets/js/media/media-app.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(ui, { filename: 'media-app.js' }));
  assert.equal(ui.includes('innerHTML'), false); assert.equal(ui.includes('setInterval'), false);
  const core = fs.readFileSync(path.join(root, 'assets/js/media/media-core.js'), 'utf8');
  assert.equal(/SetCurrentProgramScene|SetCurrentPreviewScene|SetStudioModeEnabled/.test(core), false);
});

test('installed Media, Cameras, and Setup docks use Emberstage-owned outputs without WebSocket setup', () => {
  const pages = {
    'media_dock.html': 'owned-media-app.js',
    'camera_dock.html': 'owned-camera-app.js',
    'media_setup.html': 'owned-setup-app.js',
  };
  for (const [filename, script] of Object.entries(pages)) {
    const html = fs.readFileSync(path.join(root, filename), 'utf8');
    assert.ok(html.includes(script), `${filename}: ${script}`);
    assert.equal(html.includes('obs-client.js'), false);
    assert.equal(/WebSocket address|password/i.test(html), false);
  }
  for (const filename of ['media_output.html', 'camera_output.html']) {
    const html = fs.readFileSync(path.join(root, filename), 'utf8');
    assert.ok(html.includes('Emberstage'));
    for (const match of html.matchAll(/(?:src|href)="(assets\/[^"?#]+)"/g)) assert.ok(fs.existsSync(path.join(root, match[1])), `${filename}: ${match[1]}`);
  }
  const mediaDock = fs.readFileSync(path.join(root, 'assets/js/media/owned-media-app.js'), 'utf8');
  const mediaOutput = fs.readFileSync(path.join(root, 'assets/js/outputs/media-output.js'), 'utf8');
  const cameraDock = fs.readFileSync(path.join(root, 'assets/js/media/owned-camera-app.js'), 'utf8');
  const cameraOutput = fs.readFileSync(path.join(root, 'assets/js/outputs/camera-output.js'), 'utf8');
  for (const [filename, source] of Object.entries({ mediaDock, mediaOutput, cameraDock, cameraOutput })) {
    assert.doesNotThrow(() => new vm.Script(source, { filename }));
    assert.equal(/ws:\/\/|wss:\/\/|OBSClient|server_password/.test(source), false);
  }
  assert.ok(mediaDock.includes("new BroadcastChannel('emberstage-media-v1')"));
  assert.ok(mediaOutput.includes("new BroadcastChannel('emberstage-media-v1')"));
  assert.ok(cameraDock.includes("new BroadcastChannel('emberstage-camera-v1')"));
  assert.ok(cameraOutput.includes("new BroadcastChannel('emberstage-camera-v1')"));
});

test('failed visibility writes do not produce optimistic enabled state', async () => {
  const { client, deck } = await fixture(); const original = client.request.bind(client);
  client.request = (type, data) => type === 'SetSceneItemEnabled' ? Promise.reject(new Error('Fixture write rejected')) : original(type, data);
  await assert.rejects(deck.visibility(deck.key(deck.items[1]), true, true), /write rejected/);
  assert.equal(deck.items[1].sceneItemEnabled, false); assert.equal(deck.busy, false);
});

test('target changes during revalidation block writes instead of acting on the old scene', async () => {
  const { client, deck, settings } = await fixture(); const original = client.request.bind(client); let changed = false;
  client.request = async (type, data) => {
    const result = await original(type, data);
    if (type === 'GetSceneItemList' && !changed) { changed = true; settings.update({ target: { collection: 'DEMO', sceneName: 'Holding screen', sceneUuid: 'demo-hold' } }); }
    return result;
  };
  await assert.rejects(deck.visibility(deck.key(deck.items[1]), true, true), /target changed/);
  assert.equal(mutations(client.calls).length, 0);
});
