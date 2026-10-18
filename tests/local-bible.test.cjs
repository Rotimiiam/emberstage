const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/js/control_panel/choose_bible_translation.js'), 'utf8');
const localPath = 'assets/bibles/local_msg/local_msg.js';

function setup() {
  const scripts = [];
  const options = [];
  const storage = new Map();
  const context = vm.createContext({
    document: {
      createElement: () => ({ remove() { this.removed = true; } }),
      body: { appendChild: script => scripts.push(script) },
      getElementById: id => id === 'bible-version'
        ? { appendChild: option => options.push(option), addEventListener() {} }
        : null,
    },
    localStorage: { setItem: (key, value) => storage.set(key, value) },
  });
  context.window = context;
  vm.runInContext(source, context);
  return { context, scripts, options, storage };
}

test('missing private import leaves MSG unavailable and preserves KJV fallback', async () => {
  const { context, scripts, options } = setup();
  scripts[0].onerror();
  await vm.runInContext('localBibleReady', context);
  assert.equal(options.length, 0);
  assert.equal(context.getAllowedBibleScript(localPath), 'assets/bibles/kjv/kjv.js');
  assert.equal(scripts[0].removed, true);
});

test('local import registers MSG without changing active text and persists selection', async () => {
  const { context, scripts, options, storage } = setup();
  const active = [{ name: 'Existing 1:1', verse: 'synthetic active text' }];
  context.bible_data = active;
  context.emberstageLocalMsg = [{ ari: '0:1:1', name: 'Genesis 1:1', verse: 'synthetic imported text' }];
  scripts[0].onload();
  await vm.runInContext('localBibleReady', context);
  assert.equal(context.bible_data, active);
  assert.equal(options[0].textContent, 'MSG');
  assert.equal(options[0].value, localPath);
  await context.loadScriptFile(localPath);
  assert.equal(context.bible_data, context.emberstageLocalMsg);
  assert.equal(storage.get('selectedScriptFile'), localPath);
  assert.equal(scripts.length, 1, 'cached local data needs no second script execution');
});

test('empty local import is not advertised as a working translation', async () => {
  const { context, scripts, options } = setup();
  context.emberstageLocalMsg = [];
  scripts[0].onload();
  await vm.runInContext('localBibleReady', context);
  assert.equal(options.length, 0);
  assert.equal(context.getAllowedBibleScript(localPath), 'assets/bibles/kjv/kjv.js');
});
