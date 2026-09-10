function getLibrary() {
    const data = localStorage.getItem('obs-bible-song-library-v1');
    return data ? JSON.parse(data) : [];
}

function saveLibrary(library) {
    localStorage.setItem('obs-bible-song-library-v1', JSON.stringify(library));
}

function upsertSongInLibrary(parsedSong) {
    const library = getLibrary();
    const existingIndex = library.findIndex(s => 
        s.title.toLowerCase() === parsedSong.title.toLowerCase() || 
        s.filename.toLowerCase() === parsedSong.filename.toLowerCase()
    );
    
    if (existingIndex >= 0) {
        parsedSong.id = library[existingIndex].id;
        library[existingIndex] = parsedSong;
    } else {
        library.push(parsedSong);
    }
    saveLibrary(library);
    return parsedSong.id;
}

function splitIntoBlocks(text) {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return normalized.split(/\n\s*\n+/);
}

function parseSongText(text, filename) {
    const rawLines = text.split(/\r?\n/);
    let title = '';
    const linesWithoutTitle = [];
    
    for (let line of rawLines) {
        const trimmed = line.trim();
        if (/^title:\s*/i.test(trimmed)) {
            if (!title) {
                title = trimmed.replace(/^title:\s*/i, '').trim();
            }
        } else {
            linesWithoutTitle.push(line);
        }
    }
    
    if (!title) {
        title = filename.replace(/\.txt$/i, '');
    }
    
    const contentWithoutTitle = linesWithoutTitle.join('\n');
    const blocks = splitIntoBlocks(contentWithoutTitle);
    
    const sections = [];
    let verseCounter = 1;
    let sectionOrder = 0;
    
    blocks.forEach((block) => {
        const blockLines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (blockLines.length === 0) return;
        
        let isExplicitLabel = false;
        let detectedType = null;
        let detectedLabel = '';
        
        let firstLine = blockLines[0];
        let cleaned = firstLine.trim();
        
        if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
            cleaned = cleaned.slice(1, -1).trim();
            isExplicitLabel = true;
        }
        
        if (cleaned.endsWith(':')) {
            cleaned = cleaned.slice(0, -1).trim();
            isExplicitLabel = true;
        }
        
        const cleanedUpper = cleaned.toUpperCase();
        const verseRegex = /^(VERSE|V)(\s*\d+)?$/i;
        const numRegex = /^\d+\.?$/;
        const chorusRegex = /^(CHORUS|C|CH)(\s*\d+)?$/i;
        const bridgeRegex = /^(BRIDGE|B)(\s*\d+)?$/i;
        const preChorusRegex = /^PRE[- ]?CHORUS(\s*\d+)?$/i;
        const tagRegex = /^TAG(\s*\d+)?$/i;
        const introRegex = /^INTRO(\s*\d+)?$/i;
        const outroRegex = /^OUTRO(\s*\d+)?$/i;
        const endingRegex = /^ENDING(\s*\d+)?$/i;
        const customTerms = ['REFRAIN', 'INTERLUDE', 'SELAH', 'SOLO', 'INSTRUMENTAL', 'CODA'];
        
        let match;
        if ((match = cleaned.match(verseRegex)) || numRegex.test(cleaned)) {
            isExplicitLabel = true;
            detectedType = 'verse';
            let num = '';
            if (match) {
                num = match[2] ? match[2].trim() : '';
            } else {
                num = cleaned.replace('.', '').trim();
            }
            detectedLabel = num ? `Verse ${num}` : `Verse`;
        } else if ((match = cleaned.match(chorusRegex))) {
            isExplicitLabel = true;
            detectedType = 'chorus';
            let num = match[2] ? match[2].trim() : '';
            detectedLabel = num ? `Chorus ${num}` : 'Chorus';
        } else if ((match = cleaned.match(bridgeRegex))) {
            isExplicitLabel = true;
            detectedType = 'bridge';
            let num = match[2] ? match[2].trim() : '';
            detectedLabel = num ? `Bridge ${num}` : 'Bridge';
        } else if ((match = cleaned.match(preChorusRegex))) {
            isExplicitLabel = true;
            detectedType = 'pre-chorus';
            let num = match[1] ? match[1].trim() : '';
            detectedLabel = num ? `Pre-Chorus ${num}` : 'Pre-Chorus';
        } else if ((match = cleaned.match(tagRegex))) {
            isExplicitLabel = true;
            detectedType = 'tag';
            let num = match[1] ? match[1].trim() : '';
            detectedLabel = num ? `Tag ${num}` : 'Tag';
        } else if ((match = cleaned.match(introRegex))) {
            isExplicitLabel = true;
            detectedType = 'intro';
            let num = match[1] ? match[1].trim() : '';
            detectedLabel = num ? `Intro ${num}` : 'Intro';
        } else if ((match = cleaned.match(outroRegex))) {
            isExplicitLabel = true;
            detectedType = 'outro';
            let num = match[1] ? match[1].trim() : '';
            detectedLabel = num ? `Outro ${num}` : 'Outro';
        } else if ((match = cleaned.match(endingRegex))) {
            isExplicitLabel = true;
            detectedType = 'ending';
            let num = match[1] ? match[1].trim() : '';
            detectedLabel = num ? `Ending ${num}` : 'Ending';
        } else {
            const words = cleanedUpper.split(/\s+/);
            if (customTerms.includes(words[0]) || isExplicitLabel) {
                isExplicitLabel = true;
                detectedType = 'custom';
                detectedLabel = cleaned;
            }
        }
        
        let lyricLines;
        if (isExplicitLabel) {
            lyricLines = blockLines.slice(1);
        } else {
            lyricLines = blockLines;
            detectedType = 'verse';
            detectedLabel = `Verse ${verseCounter}`;
            verseCounter++;
        }
        
        if (lyricLines.length === 0) return;
        
        const textVal = lyricLines.join('\n');
        
        sections.push({
            id: 'sec-' + Math.random().toString(36).substr(2, 9),
            type: detectedType,
            label: detectedLabel,
            order: sectionOrder++,
            text: textVal,
            lines: lyricLines
        });
    });
    
    return {
        id: 'song-' + Math.random().toString(36).substr(2, 9),
        title: title,
        filename: filename,
        updatedAt: Date.now(),
        sections: sections
    };
}

function renderLibraryList(songs, activeSongId) {
    const listContainer = document.getElementById('song-library-list');
    if (!listContainer) return;
    
    listContainer.innerHTML = '';
    
    songs.forEach(song => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'song-library-row';
        if (song.id === activeSongId) {
            button.classList.add('active');
        }
        button.dataset.songId = song.id;
        button.setAttribute('aria-label', `Select song ${song.title}`);
        
        const titleSpan = document.createElement('span');
        titleSpan.className = 'song-row-title';
        titleSpan.textContent = song.title;
        
        const badgeSpan = document.createElement('span');
        badgeSpan.className = 'song-row-badge';
        badgeSpan.textContent = song.sections.length;
        
        button.appendChild(titleSpan);
        button.appendChild(badgeSpan);
        
        button.addEventListener('click', () => {
            selectSong(song.id);
        });
        
        listContainer.appendChild(button);
    });
}

function selectSong(songId) {
    const library = getLibrary();
    const song = library.find(s => s.id === songId);
    
    const container = document.getElementById('song-display');
    const activeSongTitle = document.getElementById('active-song-title');
    
    if (!song) {
        if (activeSongTitle) activeSongTitle.textContent = 'No Song Selected';
        if (container) container.innerHTML = '';
        document.querySelectorAll('.song-library-row').forEach(row => row.classList.remove('active'));
        localStorage.removeItem('obs-bible-last-selected-song-id');
        updateEmptyStates();
        return;
    }
    
    localStorage.setItem('obs-bible-last-selected-song-id', songId);
    
    if (activeSongTitle) {
        activeSongTitle.textContent = song.title;
    }
    
    document.querySelectorAll('.song-library-row').forEach(row => {
        row.classList.toggle('active', row.dataset.songId === songId);
    });
    
    if (container) {
        container.innerHTML = '';
        
        song.sections.forEach((sectionData, index) => {
            const sectionDiv = document.createElement('div');
            sectionDiv.id = `section-${index + 1}`;
            sectionDiv.classList.add('song-section');
            
            const type = sectionData.type || 'verse';
            if (type === 'chorus') {
                sectionDiv.classList.add('chorus', 'song-chorus');
            } else {
                sectionDiv.classList.add(type);
            }
            
            sectionDiv.dataset.sectionType = type;
            sectionDiv.dataset.sectionLabel = sectionData.label;
            
            const lines = sectionData.lines || [];
            lines.forEach(line => {
                const p = document.createElement('p');
                p.textContent = line;
                sectionDiv.appendChild(p);
            });
            
            container.appendChild(sectionDiv);
        });
    }
    
    updateEmptyStates();
    
    if (typeof displaySong === 'function') {
        displaySong();
    }
}

function deleteSelectedSong() {
    const activeSongId = localStorage.getItem('obs-bible-last-selected-song-id');
    if (!activeSongId) return;
    
    const library = getLibrary();
    const index = library.findIndex(s => s.id === activeSongId);
    if (index < 0) return;
    
    const song = library[index];
    if (!confirm(`Are you sure you want to delete "${song.title}"?`)) {
        return;
    }
    
    library.splice(index, 1);
    saveLibrary(library);
    
    let nextSelectedId = null;
    if (library.length > 0) {
        if (index < library.length) {
            nextSelectedId = library[index].id;
        } else {
            nextSelectedId = library[library.length - 1].id;
        }
    }
    
    performLibrarySearch();
    selectSong(nextSelectedId);
}

function performLibrarySearch() {
    const term = document.getElementById('song-library-search')?.value?.trim()?.toLowerCase() || '';
    const modeSelect = document.getElementById('song-search-mode');
    const mode = modeSelect ? modeSelect.value : 'title';
    
    const library = getLibrary();
    let filtered;
    
    if (!term) {
        filtered = library;
    } else {
        if (mode === 'lyrics') {
            filtered = library.filter(song => {
                if (song.title.toLowerCase().includes(term)) return true;
                return song.sections.some(section => 
                    section.text.toLowerCase().includes(term) ||
                    (section.lines && section.lines.some(l => l.toLowerCase().includes(term)))
                );
            });
        } else {
            filtered = library.filter(song => song.title.toLowerCase().includes(term));
        }
    }
    
    filtered.sort((a, b) => a.title.localeCompare(b.title));
    
    const lastSelectedId = localStorage.getItem('obs-bible-last-selected-song-id');
    renderLibraryList(filtered, lastSelectedId);
    
    const emptyState = document.getElementById('song-library-empty');
    if (emptyState) {
        if (filtered.length === 0) {
            emptyState.style.display = 'flex';
            emptyState.textContent = term ? 'No matches found.' : 'No songs found.';
        } else {
            emptyState.style.display = 'none';
        }
    }
}

async function handleFileUpload(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    
    let lastSelectedId = null;
    
    for (const file of files) {
        try {
            const text = await readFileAsText(file);
            const parsedSong = parseSongText(text, file.name);
            lastSelectedId = upsertSongInLibrary(parsedSong);
        } catch (err) {
            console.error(`Failed to parse ${file.name}:`, err);
        }
    }
    
    event.target.value = '';
    
    performLibrarySearch();
    if (lastSelectedId) {
        selectSong(lastSelectedId);
    }
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(e);
        reader.readAsText(file);
    });
}

function updateEmptyStates() {
    const library = getLibrary();
    const activeSongId = localStorage.getItem('obs-bible-last-selected-song-id');
    const hasSongs = library.length > 0;
    const hasSelected = !!activeSongId && library.some(s => s.id === activeSongId);
    
    const libraryEmpty = document.getElementById('song-library-empty');
    const sectionsEmpty = document.getElementById('song-sections-empty');
    const songDisplay = document.getElementById('song-display');
    const activeSongTitle = document.getElementById('active-song-title');
    const deleteButton = document.getElementById('song-delete-button');
    
    if (libraryEmpty) {
        libraryEmpty.style.display = hasSongs ? 'none' : 'flex';
    }
    
    if (sectionsEmpty) {
        sectionsEmpty.style.display = hasSelected ? 'none' : 'flex';
    }
    
    if (songDisplay) {
        songDisplay.style.display = hasSelected ? 'block' : 'none';
    }
    
    if (!hasSelected) {
        if (activeSongTitle) {
            activeSongTitle.textContent = '';
        }
        if (deleteButton) {
            deleteButton.style.display = 'none';
        }
    } else {
        if (deleteButton) {
            deleteButton.style.display = 'inline-block';
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const lyricSearch = document.getElementById('lyric-search');
    const activeSongInfo = document.querySelector('.active-song-info');
    if (lyricSearch && activeSongInfo) {
        lyricSearch.style.display = 'inline-block';
        lyricSearch.style.maxWidth = '140px';
        lyricSearch.style.marginLeft = '12px';
        lyricSearch.style.padding = '2px 6px';
        lyricSearch.style.height = '24px';
        lyricSearch.style.fontSize = '11px';
        activeSongInfo.appendChild(lyricSearch);
    }

    const modeSelect = document.getElementById('song-search-mode');
    const titleSearch = document.getElementById('song-library-search');
    if (modeSelect && titleSearch) {
        modeSelect.addEventListener('change', () => {
            if (modeSelect.value === 'title') {
                titleSearch.placeholder = "Search title...";
            } else {
                titleSearch.placeholder = "Search lyrics...";
            }
            performLibrarySearch();
            titleSearch.focus();
        });
    }

    if (titleSearch) {
        titleSearch.addEventListener('input', () => {
            const clearBtn = document.getElementById('clear-lyrics-btn');
            if (clearBtn) {
                clearBtn.style.display = titleSearch.value ? 'block' : 'none';
            }
            performLibrarySearch();
        });
    }

    const clearBtn = document.getElementById('clear-lyrics-btn');
    if (clearBtn && titleSearch) {
        clearBtn.addEventListener('click', () => {
            titleSearch.value = '';
            clearBtn.style.display = 'none';
            performLibrarySearch();
            titleSearch.focus();
        });
    }

    const fileUpload = document.getElementById('song-file-upload');
    if (fileUpload) {
        fileUpload.addEventListener('change', handleFileUpload);
    }

    const deleteBtn = document.getElementById('song-delete-button');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', deleteSelectedSong);
    }

    performLibrarySearch();
    
    const savedSongId = localStorage.getItem('obs-bible-last-selected-song-id');
    const library = getLibrary();
    if (savedSongId && library.some(s => s.id === savedSongId)) {
        selectSong(savedSongId);
    } else if (library.length > 0) {
        library.sort((a, b) => a.title.localeCompare(b.title));
        selectSong(library[0].id);
    } else {
        selectSong(null);
    }
});
