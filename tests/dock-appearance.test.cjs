const test = require('node:test');
const assert = require('node:assert/strict');
const appearance = require('../assets/js/dock_appearance.js');

test('dock appearance keeps a church name, a safe color, and a pinned size', () => {
  const saved = appearance.sanitizeDockAppearance({
    theme: 'obs-bible-rachni',
    churchName: '  Grace Chapel  ',
    brandColor: '#0a84ff',
    logoDataUrl: 'data:image/png;base64,aaaa',
    dockSize: 'compact'
  });

  assert.equal(saved.theme, 'obs-bible-rachni');
  assert.equal(saved.churchName, 'Grace Chapel');
  assert.equal(saved.brandColor, '#0a84ff');
  assert.equal(saved.logoDataUrl, 'data:image/png;base64,aaaa');
  assert.equal(saved.dockSize, 'compact');
  assert.equal(appearance.themeAccent(saved.theme), '#28c8e4');
});

test('dock appearance drops a bad theme, color, logo, and size', () => {
  const saved = appearance.sanitizeDockAppearance({
    theme: 'dark',
    churchName: 'x'.repeat(80),
    brandColor: 'gold',
    logoDataUrl: 'https://example.test/logo.png',
    dockSize: 'huge'
  });

  assert.equal(saved.theme, 'obs-bible-default-yami');
  assert.equal(saved.churchName.length, 40);
  assert.equal(saved.brandColor, '');
  assert.equal(saved.logoDataUrl, '');
  assert.equal(saved.dockSize, 'auto');
});

test('applying appearance whitelabels the dock and pins its size', () => {
  const name = { textContent: '', hidden: true };
  const wordmark = { hidden: false };
  const logo = { src: '', getAttribute: () => 'assets/brand/emberstage-logo.svg' };
  const lockup = { label: '', setAttribute: (_, value) => { lockup.label = value; } };
  const theme = { value: '' };
  const doc = {
    body: { style: { setProperty() {} }, setAttribute() {}, classList: { toggle() {} } },
    querySelector(selector) {
      if (selector === '.dock-brand-name') return name;
      if (selector === '.dock-brand-wordmark') return wordmark;
      if (selector === '.ember-brand-logo') return logo;
      if (selector === '.dock-brand') return lockup;
      return null;
    },
    querySelectorAll() { return []; },
    getElementById(id) {
      if (id === 'obs-bible-panel-theme' || id === 'dock-appearance-theme') return theme;
      return null;
    }
  };

  appearance.applyDockAppearance(doc, {
    theme: 'obs-bible-light',
    churchName: 'City Church',
    brandColor: '#2255aa',
    dockSize: 'short'
  });

  assert.equal(name.textContent, 'City Church');
  assert.equal(name.hidden, false);
  assert.equal(wordmark.hidden, true);
  assert.equal(lockup.label, 'City Church dock');
  assert.equal(theme.value, 'obs-bible-light');
});
