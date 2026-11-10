(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.EmberstageBibleIndex = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const cache = new WeakMap();

  function bookKey(name) {
    return String(name || '').toLowerCase().replace(/\s+\d+:\d+.*$/, '');
  }

  function chapterKey(name) {
    return String(name || '').toLowerCase().replace(/:\d+.*$/, ':');
  }

  function buildBibleIndex(bibleData) {
    const rows = Array.isArray(bibleData) ? bibleData : [];
    const byName = new Map();
    const byAri = new Map();
    const byBook = new Map();
    const byChapter = new Map();
    const textRows = [];

    for (const verse of rows) {
      if (!verse || typeof verse.name !== 'string') continue;
      const name = verse.name.toLowerCase();
      byName.set(name, verse);
      if (verse.ari) byAri.set(String(verse.ari), verse);

      const book = bookKey(verse.name);
      if (!byBook.has(book)) byBook.set(book, []);
      byBook.get(book).push(verse);

      const chapter = chapterKey(verse.name);
      if (!byChapter.has(chapter)) byChapter.set(chapter, []);
      byChapter.get(chapter).push(verse);

      textRows.push({
        verse,
        text: String(verse.verse || '').toLowerCase(),
      });
    }

    return { byName, byAri, byBook, byChapter, textRows, size: rows.length };
  }

  function indexFor(bibleData) {
    if (!bibleData || typeof bibleData !== 'object') return buildBibleIndex([]);
    const cached = cache.get(bibleData);
    if (cached) return cached;
    const built = buildBibleIndex(bibleData);
    try {
      cache.set(bibleData, built);
    } catch (error) {
      return built;
    }
    return built;
  }

  return { buildBibleIndex, indexFor, bookKey, chapterKey };
});
