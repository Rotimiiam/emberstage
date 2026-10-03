function hexToRgba(hex, alpha) {
  hex = hex.replace(/^#/, '');

  let red = parseInt(hex.substring(0, 2), 16);
  let green = parseInt(hex.substring(2, 4), 16);
  let blue = parseInt(hex.substring(4, 6), 16);

  alpha = parseFloat(alpha);
  if (isNaN(alpha) || alpha < 0 || alpha > 1) {
    alpha = 1;
  }
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function getCustomPropertyValue(property) {
  return getComputedStyle(document.body).getPropertyValue(property).trim();
}


// Function to extract book, chapter, and verse from a reference string
function extractBookChapterVerse(reference) {
  // Regular expression pattern to capture book name, chapter, and verse
  // const regex = /^([\d\s\w\u00c0-\u017f]+)\s(\d+):(\d+)$/u;
  const regex = /^([\d\s\w\u00c0-\u017f]+(?:\s\([\d\s\w\u00c0-\u017f]+\))?)\s(\d+):(\d+)$/iu;

  const match = reference.match(regex);

  if (!match) {
    throw new Error("Invalid reference format");
  }

  if (match) {
    const book = match[1].trim();
    const chapter = match[2];
    const verse = match[3];
    return { book, chapter, verse };
  } else {
    throw new Error("Invalid reference format");
  }
}


function generateIndexForBibleBooks(){
  bible_data.forEach(verse => {
    try {
      const { book, chapter, verse: verseNum } = extractBookChapterVerse(verse.name);

      if (!bibleIndex.has(book)) {
        bibleIndex.set(book, new Map());
      }

      let bookIndex = bibleIndex.get(book);

      if (!bookIndex.has(chapter)) {
        bookIndex.set(chapter, new Map());
      }

      bookIndex.get(chapter).set(verseNum, verse.verse);
    } catch (error) {
      console.error(error.message);
    }
  });
}

function getSavedBible(){
  let savedBibleVerse = localStorage.getItem('savedBibleVerse');
  if (!savedBibleVerse) {
    return;
  }
  const savedBibleQuery = savedBibleVerse.split(',').filter(Boolean);
  while (bblVerseDiv.firstChild) {
      bblVerseDiv.removeChild(bblVerseDiv.firstChild);
  }
  if (savedBibleQuery.length > 0) {
    getBibeAri(savedBibleQuery);
  }
}

// Function to calculate Levenshtein Distance (fuzzy matching)
function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];

  // Initialize the matrix
  for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
  }

  // Fill the matrix
  for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
          if (b.charAt(i - 1) === a.charAt(j - 1)) {
              matrix[i][j] = matrix[i - 1][j - 1];
          } else {
              matrix[i][j] = Math.min(
                  matrix[i - 1][j - 1] + 1, // Substitution
                  matrix[i][j - 1] + 1,    // Insertion
                  matrix[i - 1][j] + 1     // Deletion
              );
          }
      }
  }

  return matrix[b.length][a.length];
}

function fuzzySearchWeight(word, text, threshold = 2) {
  word = word.toLowerCase(); // Normalize input
  const words = text.toLowerCase().split(/\s+/); // Normalize and split text
  
  if (text.toLowerCase().includes(word)) {
      return 100; // Exact substring match gets highest score
  }

  let bestWeight = 0;
  
  words.forEach(t => {
    const maxThreshold = Math.ceil(t.length * 0.4); // Allow 40% of the word length as errors
    const dist = levenshteinDistance(word, t);
    const allowed = Math.max(threshold, maxThreshold);
    
    if (dist <= allowed) {
        // Calculate weight: lower distance = higher weight
        // If distance is 0 (exact word), weight is 100
        // Weight decreases as dist increases
        let weight = Math.max(10, 100 - (dist * (100 / allowed)));
        if (weight > bestWeight) bestWeight = weight;
    }
  });
  
  return bestWeight;
}

function fuzzySearch(word, text, threshold = 2) {
  return fuzzySearchWeight(word, text, threshold) > 0;
}




function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeAndFormatMessage(inputMessage) {
  const escaped = escapeHtml(inputMessage ?? '');
  const withBold = escaped.replace(/\*(.*?)\*/g, '<span>$1</span>');
  const withItalic = withBold.replace(/_(.*?)_/g, '<em>$1</em>');
  return withItalic.replace(/\r\n|\r|\n/g, '<br>');
}

function buildVerseMarkup(reference, verseText) {
  return `<span>${escapeHtml(String(reference).toUpperCase())}</span> ${escapeHtml(verseText)}`;
}

const standardBooks = [
  "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua", "Judges", "Ruth",
  "1 Samuel", "2 Samuel", "1 Kings", "2 Kings", "1 Chronicles", "2 Chronicles", "Ezra",
  "Nehemiah", "Esther", "Job", "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon",
  "Isaiah", "Jeremiah", "Lamentations", "Ezekiel", "Daniel", "Hosea", "Joel", "Amos",
  "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk", "Zephaniah", "Haggai", "Zechariah",
  "Malachi", "Matthew", "Mark", "Luke", "John", "Acts", "Romans", "1 Corinthians",
  "2 Corinthians", "Galatians", "Ephesians", "Philippians", "Colossians", "1 Thessalonians",
  "2 Thessalonians", "1 Timothy", "2 Timothy", "Titus", "Philemon", "Hebrews", "James",
  "1 Peter", "2 Peter", "1 John", "2 John", "3 John", "Jude", "Revelation"
];

const bookAliases = {
  "genesis": 0, "gen": 0, "ge": 0, "gn": 0,
  "exodus": 1, "exo": 1, "ex": 1, "exod": 1,
  "leviticus": 2, "lev": 2, "le": 2, "lv": 2,
  "numbers": 3, "num": 3, "nu": 3, "nm": 3, "nbrs": 3,
  "deuteronomy": 4, "deut": 4, "de": 4, "dt": 4,
  "joshua": 5, "josh": 5, "jos": 5, "jsh": 5,
  "judges": 6, "judg": 6, "jdg": 6, "jg": 6, "jdgs": 6,
  "ruth": 7, "rut": 7, "ru": 7, "rth": 7,
  "1 samuel": 8, "1samuel": 8, "1 sam": 8, "1sam": 8, "1sa": 8, "1s": 8, "i samuel": 8, "i sam": 8, "1st samuel": 8, "1st sam": 8,
  "2 samuel": 9, "2samuel": 9, "2 sam": 9, "2sam": 9, "2sa": 9, "2s": 9, "ii samuel": 9, "ii sam": 9, "2nd samuel": 9, "2nd sam": 9,
  "1 kings": 10, "1kings": 10, "1 kgs": 10, "1kgs": 10, "1ki": 10, "1k": 10, "i kings": 10, "i kgs": 10, "1st kings": 10, "1st kgs": 10,
  "2 kings": 11, "2kings": 11, "2 kgs": 11, "2kgs": 11, "2ki": 11, "2k": 11, "ii kings": 11, "ii kgs": 11, "2nd kings": 11, "2nd kgs": 11,
  "1 chronicles": 12, "1chronicles": 12, "1 chr": 12, "1chr": 12, "1 ch": 12, "1ch": 12, "1 chron": 12, "1chron": 12, "i chronicles": 12, "i chr": 12, "1st chronicles": 12, "1st chr": 12,
  "2 chronicles": 13, "2chronicles": 13, "2 chr": 13, "2chr": 13, "2 ch": 13, "2ch": 13, "2 chron": 13, "2chron": 13, "ii chronicles": 13, "ii chr": 13, "2nd chronicles": 13, "2nd chr": 13,
  "ezra": 14, "ezr": 14, "ez": 14,
  "nehemiah": 15, "neh": 15, "ne": 15,
  "esther": 16, "esth": 16, "est": 16, "es": 16,
  "job": 17, "jb": 17,
  "psalms": 18, "psalm": 18, "psa": 18, "ps": 18, "pslm": 18,
  "proverbs": 19, "prov": 19, "prv": 19, "pr": 19, "pro": 19,
  "ecclesiastes": 20, "eccl": 20, "ecc": 20, "ec": 20, "eccles": 20,
  "song of solomon": 21, "song of songs": 21, "song": 21, "so": 21, "canticle": 21, "canticles": 21, "sos": 21,
  "isaiah": 22, "isa": 22, "is": 22,
  "jeremiah": 23, "jer": 23, "je": 23, "jerem": 23,
  "lamentations": 24, "lam": 24, "la": 24, "lment": 24,
  "ezekiel": 25, "ezek": 25, "eze": 25, "ezk": 25,
  "daniel": 26, "dan": 26, "da": 26, "dn": 26,
  "hosea": 27, "hos": 27, "ho": 27,
  "joel": 28, "joe": 28, "jl": 28,
  "amos": 29, "am": 29,
  "obadiah": 30, "obad": 30, "oba": 30, "ob": 30,
  "jonah": 31, "jonah": 31, "jon": 31,
  "micah": 32, "mic": 32, "mc": 32,
  "nahum": 33, "nah": 33, "na": 33,
  "habakkuk": 34, "hab": 34, "ha": 34,
  "zephaniah": 35, "zeph": 35, "zep": 35, "zp": 35,
  "haggai": 36, "hagg": 36, "hag": 36, "hg": 36,
  "zechariah": 37, "zech": 37, "zec": 37, "zach": 37, "zch": 37,
  "malachi": 38, "mal": 38, "ml": 38,
  "matthew": 39, "matt": 39, "mat": 39, "mt": 39,
  "mark": 40, "mrk": 40, "mk": 40, "mr": 40,
  "luke": 41, "luk": 41, "lk": 41,
  "john": 42, "joh": 42, "jn": 42, "jhn": 42,
  "acts": 43, "act": 43, "ac": 43,
  "romans": 44, "rom": 44, "ro": 44, "rm": 44,
  "1 corinthians": 45, "1corinthians": 45, "1 cor": 45, "1cor": 45, "1co": 45, "1c": 45, "i corinthians": 45, "i cor": 45, "1st corinthians": 45, "1st cor": 45,
  "2 corinthians": 46, "2corinthians": 46, "2 cor": 46, "2cor": 46, "2co": 46, "2c": 46, "ii corinthians": 46, "ii cor": 46, "2nd corinthians": 46, "2nd cor": 46,
  "galatians": 47, "gal": 47, "ga": 47,
  "ephesians": 48, "eph": 48, "ep": 48,
  "philippians": 49, "phil": 49, "phi": 49, "php": 49, "ph": 49,
  "colossians": 50, "col": 50, "co": 50,
  "1 thessalonians": 51, "1thessalonians": 51, "1 thess": 51, "1thess": 51, "1 thes": 51, "1thes": 51, "1th": 51, "i thessalonians": 51, "i thess": 51, "1st thessalonians": 51, "1st thess": 51,
  "2 thessalonians": 52, "2thessalonians": 52, "2 thess": 52, "2thess": 52, "2 thes": 52, "2thes": 52, "2th": 52, "ii thessalonians": 52, "ii thess": 52, "2nd thessalonians": 52, "2nd thess": 52,
  "1 timothy": 53, "1timothy": 53, "1 tim": 53, "1tim": 53, "1ti": 53, "1t": 53, "i timothy": 53, "i tim": 53, "1st timothy": 53, "1st tim": 53,
  "2 timothy": 54, "2timothy": 54, "2 tim": 54, "2tim": 54, "2ti": 54, "2t": 54, "ii timothy": 54, "ii tim": 54, "2nd timothy": 54, "2nd tim": 54,
  "titus": 55, "tit": 55, "ti": 55, "tts": 55,
  "philemon": 56, "philem": 56, "phlm": 56, "phm": 56, "plm": 56,
  "hebrews": 57, "heb": 57, "he": 57,
  "james": 58, "jas": 58, "jm": 58, "jms": 58,
  "1 peter": 59, "1peter": 59, "1 pet": 59, "1pet": 59, "1pe": 59, "1p": 59, "i peter": 59, "i pet": 59, "1st peter": 59, "1st pet": 59,
  "2 peter": 60, "2peter": 60, "2 pet": 60, "2pet": 60, "2pe": 60, "2p": 60, "ii peter": 60, "ii pet": 60, "2nd peter": 60, "2nd pet": 60,
  "1 john": 61, "1john": 61, "1 jo": 61, "1jo": 61, "1 jn": 61, "1jn": 61, "1 j": 61, "1j": 61, "i john": 61, "i jo": 61, "1st john": 61, "1st jo": 61,
  "2 john": 62, "2john": 62, "2 jo": 62, "2jo": 62, "2 jn": 62, "2jn": 62, "2 j": 62, "2j": 62, "ii john": 62, "ii jo": 62, "2nd john": 62, "2nd jo": 62,
  "3 john": 63, "3john": 63, "3 jo": 63, "3jo": 63, "3 jn": 63, "3jn": 63, "3 j": 63, "3j": 63, "iii john": 63, "iii jo": 63, "3rd john": 63, "3rd jo": 63,
  "jude": 64, "jud": 64, "jd": 64,
  "revelation": 65, "revelations": 65, "rev": 65, "re": 65, "rv": 65
};

function normalizeBookAlias(value) {
  const numbers = { i: '1', ii: '2', iii: '3', first: '1', second: '2', third: '3', '1st': '1', '2nd': '2', '3rd': '3' };
  return value.toLowerCase().replace(/[.\s]+/g, ' ').trim()
    .replace(/^(iii|ii|i|first|second|third|1st|2nd|3rd)\s+(?=[a-z])/, (_, prefix) => numbers[prefix])
    .replace(/\s/g, '');
}

// Accept unambiguous prefixes of at least three letters, but keep established
// abbreviations authoritative (Phi/Phil = Philippians, Phm = Philemon).
const bibleBookAliasIndex = new Map();
standardBooks.forEach((book, index) => {
  const key = normalizeBookAlias(book);
  const minLength = /^[1-3]/.test(key) ? 4 : 3;
  for (let length = minLength; length <= key.length; length++) {
    const prefix = key.slice(0, length);
    bibleBookAliasIndex.set(prefix, bibleBookAliasIndex.has(prefix) ? null : index);
  }
});
Object.entries(bookAliases).forEach(([alias, index]) => {
  bibleBookAliasIndex.set(normalizeBookAlias(alias), index);
});
// Derive every numbered spelling from the same aliases, rather than maintaining
// inconsistent lists for spaced, joined, ordinal and Roman references.
const bibleBookNumberPrefixes = { 1: ['1st', 'first', 'i'], 2: ['2nd', 'second', 'ii'], 3: ['3rd', 'third', 'iii'] };
Array.from(bibleBookAliasIndex).forEach(([alias, index]) => {
  if (!/^[1-3][a-z]/.test(alias)) return;
  for (const prefix of bibleBookNumberPrefixes[alias[0]]) {
    const expanded = prefix + alias.slice(1);
    // Compact Roman forms must never override real names: Isa = Isaiah,
    // while the explicitly separated I Sa = 1 Samuel.
    if (!bibleBookAliasIndex.has(expanded)) bibleBookAliasIndex.set(expanded, index);
  }
});

function resolveActiveBookName(index) {
  if (index < 0 || index >= standardBooks.length) return null;
  const standardName = standardBooks[index];
  const standardNameLower = standardName.toLowerCase();

  // 1. Prefer deriving the localized active book name from bible_data via canonical ARI book number
  if (typeof bible_data !== 'undefined' && Array.isArray(bible_data) && bible_data.length > 0) {
    let isOneBased = false;
    if (bible_data[0] && bible_data[0].ari) {
      const firstAriPart = bible_data[0].ari.split(':')[0];
      if (firstAriPart === '1') {
        isOneBased = true;
      }
    }
    const bookAriPart = String(isOneBased ? index + 1 : index);
    const foundVerse = bible_data.find(v => v && v.ari && v.ari.split(':')[0] === bookAriPart);
    if (foundVerse && foundVerse.name) {
      try {
        const extracted = extractBookChapterVerse(foundVerse.name);
        if (extracted && extracted.book) {
          return extracted.book;
        }
      } catch (err) {
        const match = foundVerse.name.match(/^([\d\s\w\u00c0-\u017f]+(?:\s\([\d\s\w\u00c0-\u017f]+\))?)\s\d+/i);
        if (match) {
          return match[1].trim();
        }
      }
    }
  }

  // If we can't find it from bible_data, use bibleIndex keys
  if (typeof bibleIndex !== 'undefined' && bibleIndex && bibleIndex.size > 0) {
    const activeBooks = Array.from(bibleIndex.keys());

    // 2. Then exact canonical-name match among bibleIndex keys (case-insensitive)
    const exactMatch = activeBooks.find(b => b.toLowerCase() === standardNameLower);
    if (exactMatch) {
      return exactMatch;
    }

    // 3. Only then controlled prefix fallback
    const prefixMatches = activeBooks.filter(b => {
      const bLower = b.toLowerCase();
      return bLower.startsWith(standardNameLower) || standardNameLower.startsWith(bLower);
    });

    if (prefixMatches.length > 0) {
      prefixMatches.sort((a, b) => {
        const diffA = Math.abs(a.length - standardName.length);
        const diffB = Math.abs(b.length - standardName.length);
        if (diffA !== diffB) return diffA - diffB;
        return b.length - a.length;
      });
      return prefixMatches[0];
    }

    // Direct index fallback if we have exactly 66 books
    if (activeBooks.length === 66 && activeBooks[index]) {
      return activeBooks[index];
    }
  }

  return standardName;
}

function getResolvedBookNameFromAlias(queryPart) {
  const index = bibleBookAliasIndex.get(normalizeBookAlias(queryPart));
  return Number.isInteger(index) ? resolveActiveBookName(index) : null;
}

function normalizeBibleReference(query) {
  if (!query) return query;
  try {
    const trimmedQuery = query.trim();
    const bookOnly = getResolvedBookNameFromAlias(trimmedQuery);
    if (bookOnly) return bookOnly;

    // Separate the reference numbers before normalizing book punctuation, so
    // Phil. 4.6 and 1.Thess.5:16 keep their chapter/verse separators intact.
    const match = trimmedQuery.match(/^(.+?)\s*(\d+)(?:\s*[:.,;/]?\s*(\d+)(?:\s*[-–—\s:]+\s*(\d+))?)?\s*$/);
    if (!match) return query;
    const resolvedBook = getResolvedBookNameFromAlias(match[1]);
    if (!resolvedBook) return query;
    const [, , chapter, startVerse, endVerse] = match;

    if (startVerse && endVerse) {
      return `${resolvedBook} ${chapter}:${startVerse}-${endVerse}`;
    } else if (startVerse) {
      return `${resolvedBook} ${chapter}:${startVerse}`;
    } else {
      return `${resolvedBook} ${chapter}`;
    }
  } catch (e) {
    return query;
  }
}
