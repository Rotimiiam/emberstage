const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('editable clipboard shortcuts retain native defaults without using clipboard permissions', () => {
  const listeners = [];
  const document = { activeElement: null, addEventListener: (type, fn) => listeners.push(fn) };
  const context = vm.createContext({ document, navigator: { get clipboard() { throw new Error('Clipboard API denied'); } } });
  vm.runInContext(fs.readFileSync(require.resolve('../assets/js/control_panel/shortcuts.js'), 'utf8'), context);
  for (const element of [{ tagName: 'TEXTAREA' }, { tagName: 'INPUT', type: 'text' }, { isContentEditable: true }]) {
    document.activeElement = element;
    for (const modifier of ['ctrlKey', 'metaKey']) {
      for (const key of ['a', 'c', 'x', 'v', 'V']) {
        let stopped = false;
        const event = { key, [modifier]: true, stopPropagation: () => stopped = true, preventDefault: () => assert.fail('Native clipboard action was blocked') };
        for (const listener of listeners) listener(event);
        assert.ok(stopped, `${modifier}+${key} should not bubble to dock shortcuts`);
      }
    }
  }
});
