const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const stored = new Map();
const results = { children: [], appendChild(el) { this.children.push(el); }, set innerHTML(v) { this.children = []; } };
const element = () => ({ addEventListener() {}, classList: { add() {}, remove() {} }, appendChild() {}, style: {} });
const ctx = vm.createContext({
  console, Map, Date, Math, setTimeout, clearTimeout,
  localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key) },
  document: { getElementById: () => element(), createElement: element, addEventListener() {} },
  bblVerseDiv: results, bibleIndex: new Map(),
});
function load(relative) { vm.runInContext(fs.readFileSync(path.join(root, relative), 'utf8'), ctx); }
load('assets/bibles/kjv/kjv.js');
load('assets/js/control_panel/utils.js');
load('assets/js/control_panel/search_bible.js');
load('assets/js/control_panel/load_song.js');
const api = vm.runInContext('({aliases:bookAliases,normalize:normalizeBibleReference,search:searchBible,data:bible_data,parse:parseSongText,save:saveLibrary,read:getLibrary})', ctx);
const checks = [];
function check(name, actual, expected) { checks.push({ name, pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected }); }
const base = Number(api.data[0].ari.split(':')[0]);
for (const [alias, index] of Object.entries(api.aliases)) {
  const book = api.data.find(v => Number(v.ari.split(':')[0]) === index + base);
  const first = api.data.find(v => v.ari === `${index + base}:1:1`);
  if (!book || !first) { check(alias + ' dataset', null, 'first verse'); continue; }
  for (const input of [`${alias} 1 1`, `${alias.toUpperCase()} 1:1`, `  ${alias}   1   1  `]) {
    check(input, api.normalize(input), first.name);
  }
  api.search(`${alias} 1 1`, api.data);
  check(alias + ' rendered ARI', stored.get('savedBibleVerse'), first.ari);
}
api.search('John 3', api.data);
const expectedChapter = api.data.filter(v => v.name.startsWith('John 3:')).map(v => v.ari).join(',');
check('Chapter excludes numbered John books', stored.get('savedBibleVerse'), expectedChapter);
for (const [alias, index] of Object.entries(api.aliases)) {
  const expected = api.data.filter(v => Number(v.ari.split(':')[0]) === index + base).map(v => v.ari).join(',');
  api.search(alias, api.data);
  check(alias + ' book-only excludes other books and verse text', stored.get('savedBibleVerse'), expected);
}
for (const [input, index, chapter, firstVerse, lastVerse] of [
  ['Phi', 49], ['Mal', 38], ['1 the', 51], ['II The.', 52],
  ['Phm', 56], ['1st The. 5:16–18', 51, 5, 16, 18], ['Mal. 3.10', 38, 3, 10, 10],
]) {
  const expected = api.data.filter(v => {
    const [book, ch, verse] = v.ari.split(':').map(Number);
    return book === index + base && (chapter === undefined || (ch === chapter && verse >= firstVerse && verse <= lastVerse));
  }).map(v => v.ari).join(',');
  api.search(input, api.data);
  check(input + ' reported shorthand actual results', stored.get('savedBibleVerse'), expected);
}
for (const text of ['looking for a job', 'well-being', 'love - never fails']) {
  try { api.search(text, api.data); check('text search handles ' + text, true, true); }
  catch (e) { check('text search handles ' + text, e.message, true); }
}
const song = api.parse('Title: Local test\n\nVerse 1\nFirst line\nSecond line\n\nCHORUS\nRefrain line\n\nVerse 2\nLast verse\n\n[Bridge]\nBridge line', 'test.txt');
check('Song title metadata', song.title, 'Local test');
check('Ordered sections, no duplication', song.sections.map(s => s.label), ['Verse 1', 'Chorus', 'Verse 2', 'Bridge']);
check('Label excluded from lyrics', song.sections[1].text, 'Refrain line');
api.save([song]);
check('Song storage roundtrip', api.read(), [song]);
vm.runInContext('addSampleHymns()', ctx);
check('Sample hymns preserve existing library', api.read()[0], song);
check('Three sample hymns added', api.read().slice(1).map(s => s.title), ['Amazing Grace', 'Holy, Holy, Holy', 'Blessed Assurance']);
check('Hymn verse and chorus cue counts', api.read().slice(1).map(s => s.sections.length), [4, 4, 6]);
check('Blessed Assurance chorus follows each verse', api.read()[3].sections.map(s => s.type), ['verse', 'chorus', 'verse', 'chorus', 'verse', 'chorus']);
check('Hymn labels excluded from output', api.read().slice(1).every(s => s.sections.every(section => section.lines.length === 4 && !section.text.includes('[Verse') && !section.text.includes('[Chorus]'))), true);
const seeded = api.read();
vm.runInContext('addSampleHymns()', ctx);
check('Samples added only once', api.read(), seeded);
api.save([song]);
vm.runInContext('addSampleHymns()', ctx);
check('Deleted hymns stay deleted on reload', api.read(), [song]);
stored.delete('emberstage-sample-hymns-v1');
const customHymn = api.parse('Title: AMAZING GRACE\n\nMy own lyrics', 'custom.txt');
api.save([customHymn]);
vm.runInContext('addSampleHymns()', ctx);
check('Existing hymn version is never overwritten', api.read()[0], customHymn);
check('Existing title does not create duplicate hymn', api.read().length, 3);
const failures = checks.filter(c => !c.pass);
const report = { aliasCount: Object.keys(api.aliases).length, books: 66, total: checks.length, passed: checks.length - failures.length, failed: failures.length, failures };
console.log(JSON.stringify(report, null, 2));
process.exitCode = failures.length ? 1 : 0;
