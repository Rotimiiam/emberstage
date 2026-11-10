const test = require('node:test');
const assert = require('node:assert/strict');
const indexApi = require('../assets/js/control_panel/bible_index.js');

const sample = [
  { name: 'John 3:16', verse: 'For God so loved the world', ari: '43:3:16' },
  { name: 'John 3:17', verse: 'For God sent not his Son', ari: '43:3:17' },
  { name: '1 John 3:16', verse: 'Hereby perceive we the love of God', ari: '62:3:16' },
  { name: 'Mark 1:1', verse: 'The beginning of the gospel', ari: '41:1:1' },
];

test('bible index finds a reference without scanning and keeps John apart from 1 John', () => {
  const index = indexApi.buildBibleIndex(sample);
  assert.equal(index.byName.get('john 3:16').ari, '43:3:16');
  assert.equal(index.byBook.get('john').length, 2);
  assert.equal(index.byBook.get('1 john').length, 1);
  assert.equal(index.byChapter.get('john 3:').length, 2);
  assert.equal(index.byAri.get('41:1:1').name, 'Mark 1:1');
});

test('bible index is reused for the same translation array', () => {
  const first = indexApi.indexFor(sample);
  const second = indexApi.indexFor(sample);
  assert.equal(first, second);
  assert.equal(first.size, 4);
});
