const ALLOWED_BIBLE_SCRIPTS = new Set([
    'assets/bibles/amplified/amplified.js',
    'assets/bibles/kjv/kjv.js',
    'assets/bibles/es_rvr/es_rvr.js',
    'assets/bibles/esv/esv.js',
    'assets/bibles/hausa_bible/hausa_bible.js',
    'assets/bibles/igbo_bible/igbo_bible.js',
    'assets/bibles/italian/italian_bible_diodati.js',
    'assets/bibles/italian/italian_new_diodati.js',
    'assets/bibles/segond_1910/segond_1910.js',
    'assets/bibles/nkjv/nkjv.js',
    'assets/bibles/niv/niv.js',
    'assets/bibles/crtb/crtb.js',
    'assets/bibles/swahili_bible/swahili_bible.js',
    'assets/bibles/yoruba_bible/yoruba_bible.js'
]);
const DEFAULT_BIBLE_SCRIPT = 'assets/bibles/kjv/kjv.js';

function getAllowedBibleScript(scriptFile) {
    return ALLOWED_BIBLE_SCRIPTS.has(scriptFile) ? scriptFile : DEFAULT_BIBLE_SCRIPT;
}

function loadScriptFile(scriptFile) {
    const allowedScriptFile = getAllowedBibleScript(scriptFile);
    return new Promise((resolve, reject) => {
        // Remove any previously loaded script
        const existingScript = document.getElementById('dynamicScript');
        if (existingScript) {
            existingScript.remove();
        }

        // Create a new script element
        const script = document.createElement('script');
        script.src = allowedScriptFile;
        script.id = 'dynamicScript';

        // Append the script to the body
        document.body.appendChild(script);

        // Save the selected script to localStorage
        localStorage.setItem('selectedScriptFile', allowedScriptFile);

        // Resolve the promise when the script loads successfully
        script.onload = function() {
            resolve();
        };

        // Reject the promise if there's an error loading the script
        script.onerror = function() {
            reject(new Error("Failed to load Bible file"));
        };
    });
}

// Listen for changes in the selected Bible version
document.getElementById("bible-version").addEventListener("change", function() {
    const selectedScriptFile = this.value;

    loadScriptFile(selectedScriptFile).then(() => {
        getSavedBible();
        generateIndexForBibleBooks();
        displayBible();
    });
});
