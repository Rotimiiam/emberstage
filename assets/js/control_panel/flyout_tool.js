document.addEventListener('DOMContentLoaded', function () {
    const textArea = document.getElementById('messageInput');
    const boldButton = document.getElementById('message-boldButton');
    const italicButton = document.getElementById('message-italicButton');
    // The toolbar is now permanent. Never hide Text style or collapse the
    // editor selection on outside clicks (native edit menus need that selection).
    [boldButton, italicButton].forEach(button => {
        button.addEventListener('mousedown', event => event.preventDefault());
    });

    textArea.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            textArea.selectionStart = textArea.selectionEnd;
            textArea.blur();
            return;
        }

        const isModifier = event.ctrlKey || event.metaKey;
        if (!isModifier) return;

        const key = event.key.toLowerCase();

        if (key === 'b') {
            event.preventDefault();
            toggleDelimiters(textArea, '*');
        } else if (key === 'i') {
            event.preventDefault();
            toggleDelimiters(textArea, '_');
        }
    });

    // --- BUTTON ACTIONS ---
    boldButton.addEventListener('click', function () {
        toggleDelimiters(textArea, '*');
    });

    italicButton.addEventListener('click', function () {
        toggleDelimiters(textArea, '_');
    });

    // --- TOGGLE FORMAT FUNCTION ---
    function toggleDelimiters(textarea, delimiter) {
        const startPos = textarea.selectionStart;
        const endPos = textarea.selectionEnd;

        if (startPos === endPos) return;

        let selectedText = textarea.value.substring(startPos, endPos);

        if (
            selectedText.startsWith(delimiter) &&
            selectedText.endsWith(delimiter)
        ) {
            selectedText = selectedText.substring(
                delimiter.length,
                selectedText.length - delimiter.length
            );
        } else {
            selectedText = delimiter + selectedText + delimiter;
        }

        const newText =
            textarea.value.substring(0, startPos) +
            selectedText +
            textarea.value.substring(endPos);

        textarea.value = newText;

        textarea.focus();
        textarea.selectionStart = startPos + delimiter.length;
        textarea.selectionEnd = endPos + delimiter.length;

        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
});
