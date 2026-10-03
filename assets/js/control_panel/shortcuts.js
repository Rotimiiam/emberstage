(function(){
    const clipboardKeys = new Set(["a", "c", "v", "x"]);

    const isEditableElement = (element) => {
        if (!element) {
            return false;
        }

        if (element.isContentEditable) {
            return true;
        }

        if (element.tagName === "TEXTAREA") {
            return !element.disabled && !element.readOnly;
        }

        if (element.tagName === "INPUT") {
            const supportedTypes = new Set([
                "text",
                "search",
                "url",
                "tel",
                "password",
                "email",
                "number"
            ]);
            const inputType = (element.type || "text").toLowerCase();
            return supportedTypes.has(inputType) && !element.disabled && !element.readOnly;
        }

        return false;
    };

    const handleClipboardShortcut = (event) => {
        const isModifier = event.ctrlKey || event.metaKey;
        if (!isModifier || event.altKey) {
            return;
        }

        const key = event.key.toLowerCase();
        if (!clipboardKeys.has(key)) {
            return;
        }

        const activeElement = document.activeElement;
        if (!isEditableElement(activeElement)) {
            return;
        }

        event.stopPropagation();
        // Keep dock shortcuts out of editing, but allow the browser's native
        // select/copy/cut/paste (including undo). OBS can deny clipboard API
        // access; preventing the native action made paste silently do nothing.
    };

    let alignContent = function(event) {
        // Check if the Control key is pressed and the 'L' key (key code 76) is pressed
        if (event.ctrlKey && event.shiftKey && event.key === 'L' || event.ctrlKey && event.shiftKey && event.key === 'l') {
            event.preventDefault();
            let selectedValue = "Left"
        
            let sendSettingsChannel = new BroadcastChannel("settings");
            sendSettingsChannel.postMessage({ selectedTextAlignment: selectedValue });
            sendSettingsChannel.close();
        }
        if (event.ctrlKey && event.shiftKey && event.key === 'R' || event.ctrlKey && event.shiftKey && event.key === 'r') {
            event.preventDefault(); 

            let selectedValue = "Right";
            let sendSettingsChannel = new BroadcastChannel("settings");
            sendSettingsChannel.postMessage({ selectedTextAlignment: selectedValue });
            sendSettingsChannel.close();
        }
        if (event.ctrlKey && event.shiftKey && event.key === 'E' || event.ctrlKey && event.shiftKey && event.key === 'e') {
            event.preventDefault(); 
            let selectedValue = "Center"
        
            let sendSettingsChannel = new BroadcastChannel("settings");
            sendSettingsChannel.postMessage({ selectedTextAlignment: selectedValue });
            sendSettingsChannel.close();
        }
        if (event.ctrlKey && event.shiftKey && event.key === 'J' || event.ctrlKey && event.shiftKey && event.key === 'j') {
            event.preventDefault();
            let selectedValue = "Justify"
        
            let sendSettingsChannel = new BroadcastChannel("settings");
            sendSettingsChannel.postMessage({ selectedTextAlignment: selectedValue });
            sendSettingsChannel.close();
        }
    }

    document.addEventListener('keydown', handleClipboardShortcut, true);
    document.addEventListener('keydown', alignContent);
})();
