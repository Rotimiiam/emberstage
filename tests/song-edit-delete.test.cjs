const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Song edit and delete workflows', () => {
  const source = fs.readFileSync(require.resolve('../assets/js/control_panel/load_song.js'), 'utf8');

  // Set up mock localStorage
  const storage = {};
  const localStorageMock = {
    getItem: (key) => storage[key] || null,
    setItem: (key, val) => { storage[key] = String(val); },
    removeItem: (key) => { delete storage[key]; }
  };

  const parentMock = {
    replaceChild: (newChild, oldChild) => {
      for (const [key, elem] of Object.entries(docElements)) {
        if (elem === oldChild) {
          docElements[key] = newChild;
        }
      }
    }
  };

  // Mock DOM elements
  const createMockElement = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      classList: {
        add: (...args) => { el._classes.push(...args); },
        remove: (...args) => { el._classes = el._classes.filter(c => !args.includes(c)); },
        toggle: (c, force) => {
          if (force === undefined) force = !el._classes.includes(c);
          if (force) el.classList.add(c);
          else el.classList.remove(c);
        }
      },
      _classes: [],
      dataset: {},
      style: {},
      children: [],
      appendChild: (child) => { el.children.push(child); child.parentNode = el; },
      parentNode: parentMock,
      replaceChild: (newChild, oldChild) => {
        const idx = el.children.indexOf(oldChild);
        if (idx >= 0) el.children[idx] = newChild;
        newChild.parentNode = el;
        for (const [key, elem] of Object.entries(docElements)) {
          if (elem === oldChild) {
            docElements[key] = newChild;
          }
        }
      },
      cloneNode: () => createMockElement(tag),
      setAttribute: (name, val) => { el._attrs[name] = val; },
      removeAttribute: (name) => { delete el._attrs[name]; },
      _attrs: {},
      addEventListener: (evt, handler) => {
        if (!el._listeners[evt]) el._listeners[evt] = [];
        el._listeners[evt].push(handler);
      },
      _listeners: {},
      _trigger: (evt) => {
        if (el._listeners[evt]) {
          el._listeners[evt].forEach(cb => cb());
        }
      }
    };
    return el;
  };

  const docElements = {
    'song-library-empty': createMockElement('div'),
    'song-sections-empty': createMockElement('div'),
    'song-display': createMockElement('div'),
    'active-song-title': createMockElement('span'),
    'song-delete-button': createMockElement('button'),
    'song-edit-button': createMockElement('button'),
    'song-delete-error': createMockElement('p'),
    'song-edit-error': createMockElement('p'),
    'song-delete-dialog': createMockElement('dialog'),
    'delete-song-title': createMockElement('span'),
    'delete-confirm-btn': createMockElement('button'),
    'delete-cancel-btn': createMockElement('button'),
    'song-edit-dialog': createMockElement('dialog'),
    'edit-song-title-input': createMockElement('input'),
    'edit-song-lyrics-input': createMockElement('textarea'),
    'edit-save-btn': createMockElement('button'),
    'edit-cancel-btn': createMockElement('button'),
    'song-library-list': createMockElement('div')
  };

  const documentMock = {
    getElementById: (id) => docElements[id] || null,
    querySelector: (sel) => {
      if (sel === '.active-song-info') return createMockElement('div');
      return null;
    },
    querySelectorAll: (sel) => [],
    createElement: (tag) => createMockElement(tag),
    addEventListener: () => {}
  };

  // Build sandboxed VM context
  let displaySongCalledWithTake = null;
  const context = vm.createContext({
    localStorage: localStorageMock,
    document: documentMock,
    console,
    Math,
    Date,
    displaySong: (take) => {
      displaySongCalledWithTake = take;
    },
    alert: (msg) => { console.log('Mock Alert:', msg); }
  });

  // Run the script to define functions in our context
  vm.runInContext(source, context);

  // Initialize library with mock songs
  const initialSongs = [
    {
      id: 'song-1',
      title: 'Amazing Grace',
      filename: 'amazing-grace.txt',
      sections: [
        { label: 'Verse 1', text: 'Amazing grace! how sweet the sound', lines: ['Amazing grace! how sweet the sound'] }
      ]
    },
    {
      id: 'song-2',
      title: 'Holy, Holy, Holy',
      filename: 'holy-holy-holy.txt',
      sections: [
        { label: 'Verse 1', text: 'Holy, holy, holy! Lord God Almighty!', lines: ['Holy, holy, holy! Lord God Almighty!'] }
      ]
    }
  ];

  localStorageMock.setItem('obs-bible-song-library-v1', JSON.stringify(initialSongs));
  localStorageMock.setItem('obs-bible-last-selected-song-id', 'song-1');

  // Test serializeSong
  const serialized = context.serializeSong(initialSongs[0]);
  assert.match(serialized, /Title: Amazing Grace/);
  assert.match(serialized, /\[Verse 1\]/);
  assert.match(serialized, /Amazing grace! how sweet the sound/);

  // Test deleteSelectedSong cancels beautifully
  displaySongCalledWithTake = null;
  context.deleteSelectedSong();
  const deleteDialog = docElements['song-delete-dialog'];
  assert.equal(docElements['delete-song-title'].textContent, 'Amazing Grace');
  
  // Trigger Cancel on delete dialog
  const deleteCancelBtn = docElements['delete-cancel-btn'];
  deleteCancelBtn._trigger('click');
  
  // Confirm nothing was deleted
  let currentLibrary = JSON.parse(localStorageMock.getItem('obs-bible-song-library-v1'));
  assert.equal(currentLibrary.length, 2);
  assert.equal(localStorageMock.getItem('obs-bible-last-selected-song-id'), 'song-1');
  assert.equal(displaySongCalledWithTake, null, 'Cancel on delete did not trigger displaySong / change live cue');

  // Test deleteSelectedSong confirms and DOES NOT change live cue (take must be false)
  displaySongCalledWithTake = null;
  context.deleteSelectedSong();
  const deleteConfirmBtn = docElements['delete-confirm-btn'];
  deleteConfirmBtn._trigger('click');

  currentLibrary = JSON.parse(localStorageMock.getItem('obs-bible-song-library-v1'));
  assert.equal(currentLibrary.length, 1);
  assert.equal(currentLibrary[0].id, 'song-2');
  assert.equal(localStorageMock.getItem('obs-bible-last-selected-song-id'), 'song-2');
  assert.equal(displaySongCalledWithTake, false, 'Confirmed delete selected next song with take = false (no live cue change)');

  // Test editSelectedSong saves correctly and DOES NOT change live cue (take must be false)
  displaySongCalledWithTake = null;
  context.editSelectedSong();
  
  const titleInput = docElements['edit-song-title-input'];
  const lyricsInput = docElements['edit-song-lyrics-input'];
  
  assert.equal(titleInput.value, 'Holy, Holy, Holy');
  assert.match(lyricsInput.value, /\[Verse 1\]/);

  // Edit the song details
  titleInput.value = 'Holy, Holy, Holy (Updated)';
  lyricsInput.value = `Title: Holy, Holy, Holy (Updated)

[Verse 1]
Holy, holy, holy! Lord God Almighty! Updated!`;

  const editSaveBtn = docElements['edit-save-btn'];
  editSaveBtn._trigger('click');

  currentLibrary = JSON.parse(localStorageMock.getItem('obs-bible-song-library-v1'));
  assert.equal(currentLibrary.length, 1);
  assert.equal(currentLibrary[0].id, 'song-2', 'Original song ID must be preserved');
  assert.equal(currentLibrary[0].title, 'Holy, Holy, Holy (Updated)', 'Title must be updated');
  assert.equal(currentLibrary[0].sections[0].label, 'Verse 1', 'Section label must be preserved');
  assert.equal(currentLibrary[0].sections[0].text, 'Holy, holy, holy! Lord God Almighty! Updated!', 'Section text must be updated');
  assert.equal(displaySongCalledWithTake, false, 'Saved edit loaded song with take = false (no live cue change)');
});
