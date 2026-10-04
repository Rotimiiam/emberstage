const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('HTTPS bridge keeps playback muted until authenticated commands; watchdog stops orphan audio', () => {
  const listeners = {}, reports = [], calls = [];
  const token = '12345678-1234-1234-1234-123456789abc';
  let now = 0, interval, options;
  const player = Object.fromEntries(['mute', 'unMute', 'playVideo', 'pauseVideo', 'destroy'].map(name => [name, () => calls.push(name)]));
  player.getPlayerState = () => 1;
  const parent = { postMessage: (data, origin) => reports.push({ data, origin }) };
  const context = vm.createContext({
    parent, URLSearchParams,
    location: { origin: 'https://emberstage.pages.dev', hash: `#video=M7lc1UVf-VE&token=${token}` },
    Date: { now: () => now },
    document: { head: { append() {} }, createElement: () => ({}) },
    setInterval: fn => { interval = fn; return 1; }, clearInterval() {},
    YT: { Player: function (_, settings) { options = settings; return player; } },
    addEventListener: (name, fn) => { listeners[name] = fn; }
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../site/youtube-player.js'), 'utf8'), context);
  context.onYouTubeIframeAPIReady();
  assert.equal(options.playerVars.origin, 'https://emberstage.pages.dev');
  assert.equal(options.playerVars.autoplay, 0);
  assert.equal(options.playerVars.controls, 1);
  options.events.onReady();
  assert.deepEqual(calls, ['mute']);
  const command = (details, overrides = {}) => listeners.message({ source: parent, origin: 'null',
    data: { channel: 'emberstage-youtube', version: 1, token, ...details }, ...overrides });
  command({ type: 'play' }, { source: {} });
  command({ type: 'play', token: 'wrong' });
  assert.deepEqual(calls, ['mute']);
  command({ type: 'play' });
  command({ type: 'mute', muted: false });
  assert.deepEqual(calls, ['mute', 'playVideo', 'unMute']);
  command({ type: 'pause' }, { origin: 'https://different.example' });
  assert.equal(calls.at(-1), 'unMute');
  now = 7000;
  interval();
  assert.deepEqual(calls.slice(-2), ['mute', 'pauseVideo']);
  options.events.onError({ data: 150 });
  assert.equal(reports.at(-1).data.code, 150);
  assert.equal(reports.at(-1).origin, '*', 'file:// parent requires wildcard but exact parent WindowProxy');
  command({ type: 'stop' });
  assert.equal(calls.at(-1), 'destroy');
});
