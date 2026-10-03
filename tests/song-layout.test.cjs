const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../assets/js/browser_source/broadcast_branding_shared.js');
const fs = require('node:fs');
const vm = require('node:vm');

test('lyric paging scrolls within its pane without jumping to verse one', () => {
  const source = fs.readFileSync(require.resolve('../assets/js/control_panel/send_message.js'), 'utf8');
  const container = { scrollTop: 600, clientTop: 1, clientHeight: 200, getBoundingClientRect: () => ({ top: 100 }) };
  const context = vm.createContext({ document: { getElementById: () => container } });
  vm.runInContext(source.match(/function scrollToElement\(element\) \{[\s\S]*?\n\}/)[0], context);
  const scroll = (top, height) => context.scrollToElement({ offsetTop: 12, getBoundingClientRect: () => ({ top, height, bottom: top + height }) });
  scroll(160,30); assert.equal(container.scrollTop,600,'visible line in later verse stays in place');
  scroll(290,30); assert.equal(container.scrollTop,619,'only scroll enough to reveal next line');
  scroll(80,30); assert.equal(container.scrollTop,598,'previous line scrolls up locally, not to verse one');
  scroll(150,300); assert.equal(container.scrollTop,647,'oversized verse aligns its start');
});

test('song look settings allow only supported layouts and positions', () => {
  assert.deepEqual(api.sanitizeSongLayout(null), { layout: 'full-screen', position: 'left' });
  assert.deepEqual(api.sanitizeSongLayout({ layout: 'unknown', position: 'top' }), { layout: 'full-screen', position: 'left' });
  assert.equal(api.isCompactSongLayout('lower-third'), true);
  assert.equal(api.isCompactSongLayout('full-screen'), false);
  for (const layout of ['full-screen', 'lower-third', 'gradient-strip', 'lyric-card', 'side-panel']) {
    assert.deepEqual(api.sanitizeSongLayout({ layout, position: 'right' }), { layout, position: 'right' });
  }
});

test('song cues preserve the anchor while layouts change and never spill into another section', () => {
  const cue = { lines: ['One', 'Two', 'Three', 'Four', 'Five'], lineIndex: 2 };
  for (const layout of ['lower-third', 'gradient-strip', 'lyric-card']) {
    assert.deepEqual(api.songCueLines(cue, layout), ['Three', 'Four']);
    assert.deepEqual(api.songCueLines({ ...cue, lineIndex: 4 }, layout), ['Five']);
  }
  for (const layout of ['side-panel', 'full-screen']) {
    assert.deepEqual(api.songCueLines(cue, layout), cue.lines);
  }
  assert.equal(cue.lineIndex, 2);
  assert.deepEqual(api.songCueLines(cue, 'lower-third'), ['Three', 'Four']);
});

test('line-by-line mode remains a single lyric in every look', () => {
  const cue = { lines: ['One', 'Two', 'Three'], lineIndex: 1, singleLine: true };
  for (const layout of ['full-screen', 'lower-third', 'gradient-strip', 'lyric-card', 'side-panel']) {
    assert.deepEqual(api.songCueLines(cue, layout), ['Two']);
  }
});

test('compact song looks expose stable part counts for chunk navigation', () => {
  const cue = { lines: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'], lineIndex: 4, singleLine: false };
  assert.deepEqual(api.songCuePagination(cue, 'lower-third'), { step: 2, pageIndex: 2, pageCount: 3 });
  assert.deepEqual(api.songCuePagination({ ...cue, lineIndex: 5 }, 'gradient-strip'), { step: 2, pageIndex: 2, pageCount: 3 });
  assert.deepEqual(api.songCuePagination({ ...cue, singleLine: true }, 'lyric-card'), { step: 1, pageIndex: 4, pageCount: 6 });
  assert.deepEqual(api.songCuePagination(cue, 'full-screen'), { step: 6, pageIndex: 0, pageCount: 1 });
});

test('song metadata survives payload persistence but cannot attach to scripture or manual text', () => {
  const cue = { lines: ['A < B', 'C & D'], lineIndex: 1, singleLine: false };
  const payload = api.coerceMessagePayload({ kind: 'song', messageContent: 'C &amp; D', song: cue });
  assert.deepEqual(JSON.parse(JSON.stringify(payload)).song, cue);
  for (const kind of ['', 'scripture']) assert.equal(api.coerceMessagePayload({ kind, song: cue }).song, null);
  assert.equal(api.sanitizeSongCue({ lines: [] }), null);
  assert.equal(api.sanitizeSongCue({ lines: ['a'], lineIndex: -5 }).lineIndex, 0);
  assert.equal(api.sanitizeSongCue({ lines: ['a', 'b'], lineIndex: 500 }).lineIndex, 1);
});

test('getExpandedSections repeats chorus after each verse when not already explicit', () => {
  const loadSongSource = fs.readFileSync(require.resolve('../assets/js/control_panel/load_song.js'), 'utf8');
  const context = vm.createContext({
    localStorage: { getItem: () => null, setItem: () => null },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
    console,
    Math,
    Date
  });
  vm.runInContext(loadSongSource, context);
  const getExpandedSections = context.getExpandedSections;

  // Case 1: Verse and Chorus, chorus should repeat after each verse
  const sections1 = [
    { id: 'sec-1', type: 'verse', label: 'Verse 1', lines: ['V1 Line 1'] },
    { id: 'sec-2', type: 'verse', label: 'Verse 2', lines: ['V2 Line 1'] },
    { id: 'sec-3', type: 'chorus', label: 'Chorus', lines: ['Chorus Line 1'] }
  ];
  const expanded1 = getExpandedSections(sections1);
  assert.equal(expanded1.length, 4);
  assert.equal(expanded1[0].id, 'sec-1');
  assert.equal(expanded1[1].id, 'sec-3-repeat-0');
  assert.equal(expanded1[1].label, 'Chorus');
  assert.equal(expanded1[2].id, 'sec-2');
  assert.equal(expanded1[3].id, 'sec-3');

  // Case 4: Chorus at the beginning, followed by multiple verses
  const sections4 = [
    { id: 'sec-3', type: 'chorus', label: 'Chorus', lines: ['Chorus Line 1'] },
    { id: 'sec-1', type: 'verse', label: 'Verse 1', lines: ['V1 Line 1'] },
    { id: 'sec-2', type: 'verse', label: 'Verse 2', lines: ['V2 Line 1'] }
  ];
  const expanded4 = getExpandedSections(sections4);
  assert.equal(expanded4.length, 5); // [Chorus, Verse 1, Chorus-repeat-1, Verse 2, Chorus-repeat-2]
  assert.equal(expanded4[0].id, 'sec-3');
  assert.equal(expanded4[1].id, 'sec-1');
  assert.equal(expanded4[2].id, 'sec-3-repeat-1');
  assert.equal(expanded4[3].id, 'sec-2');
  assert.equal(expanded4[4].id, 'sec-3-repeat-2');

  // Case 2: Chorus already explicit after each verse, no duplication
  const sections2 = [
    { id: 'sec-1', type: 'verse', label: 'Verse 1', lines: ['V1 Line 1'] },
    { id: 'sec-2', type: 'chorus', label: 'Chorus', lines: ['Chorus Line 1'] },
    { id: 'sec-3', type: 'verse', label: 'Verse 2', lines: ['V2 Line 1'] },
    { id: 'sec-4', type: 'chorus', label: 'Chorus', lines: ['Chorus Line 1'] }
  ];
  const expanded2 = getExpandedSections(sections2);
  assert.equal(expanded2.length, 4);
  assert.equal(expanded2[0].id, 'sec-1');
  assert.equal(expanded2[1].id, 'sec-2');
  assert.equal(expanded2[2].id, 'sec-3');
  assert.equal(expanded2[3].id, 'sec-4');

  // Case 3: No chorus, no change
  const sections3 = [
    { id: 'sec-1', type: 'verse', label: 'Verse 1', lines: ['V1 Line 1'] },
    { id: 'sec-2', type: 'verse', label: 'Verse 2', lines: ['V2 Line 1'] }
  ];
  const expanded3 = getExpandedSections(sections3);
  assert.deepEqual(expanded3, sections3);

  const original = JSON.stringify(sections1);
  getExpandedSections(sections1);
  assert.equal(JSON.stringify(sections1), original, 'stored sections are not modified');
  const refrain = { id: 'r', type: 'custom', label: 'Refrain', lines: ['Shared refrain'] };
  assert.equal(getExpandedSections([sections3[0], refrain, sections3[1]]).length, 4);
  for (const extra of [
    { type: 'pre-chorus', label: 'Pre-Chorus', lines: ['Build'] },
    { type: 'bridge', label: 'Bridge', lines: ['Bridge'] },
    { type: 'chorus', label: 'Chorus 2', lines: ['Different chorus'] },
  ]) {
    const arranged = [...sections1, extra];
    assert.deepEqual(getExpandedSections(arranged), arranged, 'explicit complex arrangement is preserved');
  }
});

test('side-panel shows entire verse and respects single line', () => {
  const cue = { lines: ['Line A', 'Line B', 'Line C'], lineIndex: 1, singleLine: false };
  // Non-compact side-panel layout returns all lines (full verse)
  assert.deepEqual(api.songCueLines(cue, 'side-panel'), ['Line A', 'Line B', 'Line C']);

  // Single-line mode returns only the active line
  assert.deepEqual(api.songCueLines({ ...cue, singleLine: true }, 'side-panel'), ['Line B']);
});

test('half-screen keeps all verse lines and advances one whole verse', () => {
  const cue = { lines: ['One', 'Two', 'Three', 'Four', 'Five'], lineIndex: 0, singleLine: false };
  assert.equal(api.sanitizeSongLayout({ layout: 'half-screen' }).layout, 'half-screen');
  assert.deepEqual(api.songCueLines(cue, 'half-screen'), cue.lines);
  assert.equal(api.songCuePagination(cue, 'half-screen').pageCount, 1);
  assert.equal(api.isCompactSongLayout('half-screen'), false);
});
