const test = require('node:test');
const assert = require('node:assert/strict');
const branding = require('../assets/js/browser_source/broadcast_branding_shared.js');

test('text broadcast layouts are opt-in and retain lines without a scripture heading', () => {
  const payload = { kind: 'text', messageContent: '<span>Welcome &amp; hello</span><br>Second line<br>Third line' };
  assert.equal(branding.shouldUseBroadcastLayout(payload, {}), false);
  for (const layout of ['lower-third', 'full-screen']) {
    assert.equal(branding.shouldUseBroadcastLayout(payload, { layout }), true);
    assert.equal(branding.shouldUseBroadcastLayout({ kind: 'song' }, { layout }), false);
    assert.equal(branding.shouldUseBroadcastLayout({ kind: '' }, { layout }), false);
  }
  assert.deepEqual(branding.extractScriptureParts(payload), {
    reference: '', verseText: 'Welcome & hello\nSecond line\nThird line',
  });
  assert.notEqual(branding.TEXT_STORAGE_KEYS.applied, branding.STORAGE_KEYS.applied);
  assert.notEqual(branding.TEXT_STORAGE_KEYS.draft, branding.STORAGE_KEYS.draft);
});

test('sanitizeBroadcastSettings keeps known values and rejects unsafe logo payloads', () => {
  const settings = branding.sanitizeBroadcastSettings({
    layout: 'full-screen',
    churchName: '  Grace   Assembly  ',
    logoDataUrl: 'data:image/png;base64,QUJDRA==',
    accentColor: '#C8A45A',
    logoPosition: 'in-card',
    entranceStyle: 'rise',
    entranceDuration: 500,
    exitStyle: 'fade',
    exitDuration: 150,
  });

  assert.deepEqual(settings, {
    layout: 'full-screen',
    churchName: 'Grace Assembly',
    logoDataUrl: 'data:image/png;base64,QUJDRA==',
    accentColor: '#c8a45a',
    logoPosition: 'in-card',
    entranceStyle: 'rise',
    entranceDuration: 500,
    exitStyle: 'fade',
    exitDuration: 150,
    safeMarginPercent: 5,
  });

  const fallback = branding.sanitizeBroadcastSettings({
    layout: 'wild',
    accentColor: 'red',
    logoDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    entranceDuration: 260,
  });

  assert.equal(fallback.layout, 'legacy');
  assert.equal(fallback.accentColor, branding.DEFAULT_BROADCAST_SETTINGS.accentColor);
  assert.equal(fallback.logoDataUrl, '');
  assert.equal(fallback.entranceDuration, 300);
});

test('logo and scripture helpers preserve safe protocol rules', () => {
  assert.equal(branding.isAllowedLogoMimeType('image/png'), true);
  assert.equal(branding.isAllowedLogoMimeType('image/gif'), true);
  assert.equal(branding.isAllowedLogoMimeType('image/svg+xml'), false);
  assert.equal(branding.isSafeLogoDataUrl('data:image/webp;base64,QUJDRA=='), true);
  assert.equal(branding.isSafeLogoDataUrl('data:image/gif;base64,R0lGODlh'), true);
  assert.equal(branding.isSafeLogoDataUrl('https://example.com/logo.png'), false);

  const payload = branding.coerceMessagePayload({
    messageContent: '<span>Psalm 23:1</span> The Lord is my shepherd',
    kind: 'scripture',
    scripture: { reference: 'Psalm 23:1', verseText: 'The Lord is my shepherd' },
  });
  assert.equal(branding.shouldUseBroadcastLayout(payload, { layout: 'lower-third' }), true);
  assert.deepEqual(branding.extractScriptureParts(payload), {
    reference: 'Psalm 23:1',
    verseText: 'The Lord is my shepherd',
  });

  const legacyExtract = branding.extractScriptureParts({
    messageContent: '<span>John 3:16</span> For God so loved the world<br>that he gave his only begotten Son',
  });
  assert.deepEqual(legacyExtract, {
    reference: 'John 3:16',
    verseText: 'For God so loved the world that he gave his only begotten Son',
  });
});

test('branding defaults beside scripture and preserves GIF bytes and saved corner choices', () => {
  const gif = 'data:image/gif;base64,R0lGODlh';
  const settings = branding.sanitizeBroadcastSettings({ logoDataUrl: gif });
  assert.equal(settings.logoPosition, 'in-card');
  assert.equal(settings.logoDataUrl, gif);
  assert.equal(branding.sanitizeBroadcastSettings({ logoPosition: 'top-left' }).logoPosition, 'top-left');
  assert.equal(branding.isSafeLogoDataUrl('data:image/gif;base64,' + 'A'.repeat(branding.MAX_LOGO_DATA_URL_LENGTH)), false);
  assert.equal(branding.isSafeLogoDataUrl('data:image/gif,<svg onload=alert(1)>'), false);
});
