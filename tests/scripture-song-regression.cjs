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
const failures = checks.filter(c => !c.pass);
const report = { aliasCount: Object.keys(api.aliases).length, books: 66, total: checks.length, passed: checks.length - failures.length, failed: failures.length, failures };
console.log(JSON.stringify(report, null, 2));
process.exitCode = failures.length ? 1 : 0;
