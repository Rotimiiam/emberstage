const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/js/control_panel/utils.js'), 'utf8'), context);

test('spaced and compact Bible shorthand, chapters and verse ranges', () => {
  for (const [input, expected] of [
    ['1 s 4 5', '1 Samuel 4:5'], ['1s4:5', '1 Samuel 4:5'],
    ['1 sam 4 5', '1 Samuel 4:5'], ['1 Samuel 4:5', '1 Samuel 4:5'],
    ['  2 S 4 5  ', '2 Samuel 4:5'], ['2 sam 4:5-7', '2 Samuel 4:5-7'],
    ['jn3:16', 'John 3:16'], ['jn 3 16', 'John 3:16'],
    ['ps23', 'Psalms 23'], ['John 12', 'John 12'],
    ['1 j 2 3', '1 John 2:3'], ['3 j 1 2', '3 John 1:2'],
    ['1 chr 2:3', '1 Chronicles 2:3'], ['2 thess 2 3', '2 Thessalonians 2:3'],
    ['ii sam 4:5', '2 Samuel 4:5'], ['John 3:16-18', 'John 3:16-18'],
    ['John 3 16 18', 'John 3:16-18'], ['John 3.16', 'John 3:16'],
  ]) assert.equal(context.normalizeBibleReference(input), expected, input);
  assert.equal(context.getResolvedBookNameFromAlias('1 s'), '1 Samuel');
});

test('unknown abbreviations and text searches are not guessed as references', () => {
  for (const input of ['For God so loved the world', 'johnny 3 16', '1 x 4 5', 'justice 4 5', 'John 3:16 trailing', 'ma 1:1', 'jo 1:1', 'the 1:1', '1nd the 1:1', 'love 3:16', '']) {
    assert.equal(context.normalizeBibleReference(input), input);
  }
});

test('reported shorthand, dotted names, prefixes and numbered-book spellings', () => {
  for (const [input, expected] of [
    ['Phi', 'Philippians'], ['Phi 4:6', 'Philippians 4:6'],
    ['Mal', 'Malachi'], ['Mal.3.10', 'Malachi 3:10'],
    ['1 the', '1 Thessalonians'], ['1 the 5 16', '1 Thessalonians 5:16'],
    ['1st The. 5:16–18', '1 Thessalonians 5:16-18'],
    ['II.Thes.2:3', '2 Thessalonians 2:3'], ['IThess5:16', '1 Thessalonians 5:16'],
    ['First Thess 5:16', '1 Thessalonians 5:16'], ['2ndPet1:2', '2 Peter 1:2'],
    ['III Jn 1:2', '3 John 1:2'], ['third john', '3 John'],
    ['Deu 6:4', 'Deuteronomy 6:4'], ['Revel 1:1', 'Revelation 1:1'],
    ['S.O.S. 2:1', 'Song of Solomon 2:1'], ['  1   Chron. 2:3  ', '1 Chronicles 2:3'],
    ['Phm 1:4', 'Philemon 1:4'], ['Phile 1:4', 'Philemon 1:4'],
    ['Phil 1:4', 'Philippians 1:4'], ['Phili 1:4', 'Philippians 1:4'],
    ['Jud 1:3', 'Jude 1:3'], ['Judg 1:3', 'Judges 1:3'],
    ['Joel 1:3', 'Joel 1:3'], ['Jon 1:3', 'Jonah 1:3'],
    ['John 1:3', 'John 1:3'], ['Job 1:3', 'Job 1:3'],
    ['1 Th 1:3', '1 Thessalonians 1:3'], ['1 Ti 1:3', '1 Timothy 1:3'],
    ['Isa 1:1', 'Isaiah 1:1'], ['Is 1:1', 'Isaiah 1:1'],
    ['I Sa 1:1', '1 Samuel 1:1'], ['I.Sa.1:1', '1 Samuel 1:1'],
  ]) assert.equal(context.normalizeBibleReference(input), expected, input);
});

const books = vm.runInContext('standardBooks.slice()', context);
const commonShortNames = [
  'Gen', 'Ex', 'Lev', 'Num', 'Deu', 'Josh', 'Judg', 'Ru',
  '1 Sam', '2 Sam', '1 Kgs', '2 Kgs', '1 Chr', '2 Chr', 'Ezr', 'Neh',
  'Est', 'Job', 'Ps', 'Prov', 'Eccl', 'Sos', 'Isa', 'Jer', 'Lam', 'Ezek',
  'Dan', 'Hos', 'Joel', 'Am', 'Obad', 'Jon', 'Mic', 'Nah', 'Hab', 'Zeph',
  'Hag', 'Zech', 'Mal', 'Matt', 'Mk', 'Lk', 'Jn', 'Acts', 'Rom', '1 Cor',
  '2 Cor', 'Gal', 'Eph', 'Phi', 'Col', '1 The', '2 The', '1 Tim', '2 Tim',
  'Tit', 'Phm', 'Heb', 'Jas', '1 Pet', '2 Pet', '1 Jn', '2 Jn', '3 Jn', 'Jude', 'Rev',
];
assert.equal(commonShortNames.length, books.length);
books.forEach((book, index) => {
  test(`${book}: book-only, chapter, verse and range shorthand`, () => {
    const alias = commonShortNames[index];
    const forms = [book, alias, alias.toUpperCase(), alias.replace(/ /g, ''), alias + '.'];
    const number = alias.match(/^([1-3]) (.+)$/);
    if (number) {
      const prefixes = { 1: ['1st', 'first', 'I'], 2: ['2nd', 'second', 'II'], 3: ['3rd', 'third', 'III'] };
      for (const prefix of prefixes[number[1]]) forms.push(`${prefix} ${number[2]}.`);
    }
    for (const form of forms) {
      for (const [suffix, result] of [['', ''], [' 1', ' 1'], ['1:1', ' 1:1'], [' 1 1 3', ' 1:1-3'], [' 1.1—3', ' 1:1-3']]) {
        assert.equal(context.normalizeBibleReference(form + suffix), book + result, form + suffix);
      }
    }
  });
});

function searchHarness(data = []) {
  const element = () => ({
    children: [], listeners: {}, value: '', classList: { add() {} },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    appendChild(child) { this.children.push(child); },
    set innerHTML(value) { this.children = []; },
  });
  const elements = new Map();
  const results = element();
  const stored = new Map();
  const ctx = vm.createContext({
    bible_data: data, bblVerseDiv: results,
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element, addEventListener() {} },
    localStorage: { setItem(key, value) { stored.set(key, String(value)); } },
  });
  for (const file of ['utils.js', 'search_bible.js', 'suggest_bible_books.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/js/control_panel', file), 'utf8'), ctx);
  }
  return { ctx, elements, results, stored };
}

test('autocomplete ranks recognized shorthand before fuzzy matches without duplicates', () => {
  const { ctx, elements } = searchHarness();
  vm.runInContext('standardBooks.forEach(book => bibleIndex.set(book, new Map()))', ctx);
  for (const [input, expected] of [['Phi', 'Philippians'], ['Mal', 'Malachi'], ['1 the', '1 Thessalonians'], ['Phm', 'Philemon'], ['Isa', 'Isaiah']]) {
    elements.get('bible-input').value = input;
    elements.get('bible-input').listeners.input();
    const suggestions = elements.get('suggestions').children.map(child => child.textContent.trim());
    assert.equal(suggestions[0], expected, input);
    assert.equal(suggestions.filter(book => book === expected).length, 1, input);
  }
});

test('shorthand preserves active translation and zero/one-based ARI numbering', () => {
  for (const base of [0, 1]) {
    const data = [
      { ari: `${base}:1:1`, name: 'Genèse 1:1', verse: 'Example' },
      { ari: `${38 + base}:3:10`, name: 'Malachie 3:10', verse: 'Example' },
      { ari: `${49 + base}:4:6`, name: 'Philippiens 4:6', verse: 'Example' },
      { ari: `${51 + base}:5:16`, name: '1 Thessaloniciens 5:16', verse: 'Example' },
    ];
    const { ctx, stored } = searchHarness(data);
    for (const [input, verse] of [['Mal', data[1]], ['Mal.3:10', data[1]], ['Phi', data[2]], ['Phi 4:6', data[2]], ['1 the', data[3]], ['I The.5:16', data[3]]]) {
      ctx.searchBible(input, data);
      assert.equal(stored.get('savedBibleVerse'), verse.ari, `${input} base ${base}`);
    }
  }
});
