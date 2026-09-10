const lyricInput = document.getElementById('lyric-search');
const clearLyricsBtn = document.getElementById('clear-lyrics-btn');
const clearBibleBtn = document.getElementById('clear-bible-btn');
const bibleSearchInput = document.getElementById('bible-input');
const lyricsSearchNav = document.getElementById('lyrics-search-nav');
const prevMatchBtn = document.getElementById('prev-match-btn');
const nextMatchBtn = document.getElementById('next-match-btn');

let currentMatches = [];
let currentMatchIndex = -1;

function scrollToVerse(verse) {
    const displayLine = document.getElementById('song');
    let songDiv = document.getElementById("song-display");
    if (!displayLine || !songDiv || !verse) return;
    
    const parentNode = verse.parentNode;
    let lineHeight = songDiv.offsetHeight;
    const parentTop = parentNode.offsetTop;
    const scrollTop = parentTop + verse.offsetTop - (lineHeight / 2);
    displayLine.scrollTop = scrollTop;
}

function updateNavigationUI() {
    if (currentMatches.length > 0) {
        if (lyricsSearchNav) lyricsSearchNav.style.display = 'flex';
        currentMatches.forEach((match, index) => {
            if (index === currentMatchIndex) {
                 match.element.classList.add('selected');
                 scrollToVerse(match.element);
            } else {
                 match.element.classList.remove('selected');
            }
        });
    } else {
        if (lyricsSearchNav) lyricsSearchNav.style.display = 'none';
        const verses = document.querySelectorAll('#song-display p');
        verses.forEach(v => v.classList.remove('selected'));
    }
}

if (lyricInput) {
    lyricInput.addEventListener('keyup', () => {
        if (lyricInput.value.length > 2) {
            const searchTerm = lyricInput.value.toLowerCase();
            const verses = document.querySelectorAll('#song-display p');
            
            currentMatches = [];
            
            verses.forEach(verse => {
                const verseText = verse.textContent.toLowerCase();
                verse.classList.remove("selected");

                let searchWeight = typeof fuzzySearchWeight === 'function' ? fuzzySearchWeight(searchTerm, verseText) : (verseText.includes(searchTerm) ? 100 : 0);

                if (searchWeight > 0) {
                    currentMatches.push({ element: verse, weight: searchWeight });
                }
            });
            
            if (currentMatches.length > 0) {
                currentMatches.sort((a, b) => b.weight - a.weight);
                currentMatchIndex = 0;
            } else {
                currentMatchIndex = -1;
            }
            
            updateNavigationUI();
        } else {
            currentMatches = [];
            currentMatchIndex = -1;
            updateNavigationUI();
        }
    });

    lyricInput.addEventListener('input', () => {
        if (clearLyricsBtn) {
            clearLyricsBtn.style.display = lyricInput.value ? 'block' : 'none';
        }
    });
}

if (prevMatchBtn) {
    prevMatchBtn.addEventListener('click', () => {
        if (currentMatches.length > 0) {
            currentMatchIndex--;
            if (currentMatchIndex < 0) currentMatchIndex = currentMatches.length - 1;
            updateNavigationUI();
        }
    });
}

if (nextMatchBtn) {
    nextMatchBtn.addEventListener('click', () => {
        if (currentMatches.length > 0) {
            currentMatchIndex++;
            if (currentMatchIndex >= currentMatches.length) currentMatchIndex = 0;
            updateNavigationUI();
        }
    });
}

if (clearLyricsBtn && lyricInput) {
    clearLyricsBtn.addEventListener('click', () => {
        lyricInput.value = '';
        lyricInput.focus();
        clearLyricsBtn.style.display = 'none';
        currentMatches = [];
        currentMatchIndex = -1;
        updateNavigationUI();
    });
}

if (clearBibleBtn && bibleSearchInput) {
    clearBibleBtn.addEventListener('click', () => {
        bibleSearchInput.value = '';
        bibleSearchInput.focus();
        clearBibleBtn.style.display = 'none';
    });
}

if (bibleSearchInput && clearBibleBtn) {
    bibleSearchInput.addEventListener('input', () => {
        clearBibleBtn.style.display = bibleSearchInput.value ? 'block' : 'none';
    });
}
