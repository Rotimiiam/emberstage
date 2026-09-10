-- Native Emberstage media hotkeys. No browser bridge, source creation or scene switching.
-- Registration/persistence follows OBS's installed instant-replay.lua.
local obs = obslua
local selected, pinned_identity = "", ""
local enabled, exclusive_video, exclusive_picture = false, false, false
local loaded, ready, watching = false, false, false
local bindings, registrations = nil, {}
local notices = {}
local status = "Choose an output scene, then assign keys in Settings > Hotkeys."
local rescan

local function log(message)
    if type(obs.script_log) == "function" then
        obs.script_log(obs.LOG_WARNING, "Emberstage: " .. tostring(message))
    end
end

local function warn_once(message)
    if not notices[message] then notices[message] = true; log(message) end
end

local function guarded(fn)
    local ok, err = pcall(fn)
    if not ok then log(err) end
    return ok
end

-- Release owned OBS objects even if a visitor or optional API throws.
local function using(value, release, fn)
    if value == nil then return nil end
    local ok, result = pcall(fn, value)
    release(value)
    if not ok then error(result, 0) end
    return result
end

local function encode(value)
    return (tostring(value):gsub("([^%w_-])", function(c)
        return string.format("%%%02X", string.byte(c))
    end))
end

local function identity(source)
    if type(obs.obs_source_get_uuid) == "function" then
        local ok, uuid = pcall(obs.obs_source_get_uuid, source)
        if ok and uuid and uuid ~= "" then return "uuid:" .. uuid end
    end
    warn_once("Source UUID API unavailable; name/type/item IDs are used. Renames require re-binding; old bindings remain saved.")
    return "name:" .. obs.obs_source_get_name(source) .. ":" .. obs.obs_source_get_id(source)
end

local kinds = {
    dshow_input = "camera",
    ffmpeg_source = "video", vlc_source = "video",
    image_source = "picture", slideshow = "picture",
    window_capture = "capture", game_capture = "capture", monitor_capture = "capture",
    screen_capture = "capture", xcomposite_input = "capture", xshm_input = "capture",
}

local function source_kind(source)
    local id = obs.obs_source_get_id(source)
    if type(obs.obs_source_get_unversioned_id) == "function" then
        local ok, unversioned = pcall(obs.obs_source_get_unversioned_id, source)
        if ok and unversioned and unversioned ~= "" then id = unversioned end
    end
    return kinds[id]
end

-- Enumerated item/source handles are borrowed, never retained after list release.
-- Recurse through groups only: nested scene sources are deliberately not expanded.
local function visit_scene(visitor)
    if selected == "" then return false end
    local source = obs.obs_get_source_by_name(selected)
    if not source then return false end
    return using(source, obs.obs_source_release, function(root)
        local scene = obs.obs_scene_from_source(root)
        if not scene then return false end
        local root_identity = identity(root)
        if pinned_identity ~= "" and pinned_identity ~= root_identity then
            warn_once("The chosen scene was replaced. Choose no scene, then explicitly choose the replacement to enable it.")
            return false
        end
        pinned_identity = root_identity
        local prefix = "media_deck/v1/" .. encode(selected) .. "/" .. encode(root_identity)
        local function walk(container, key_path, label_path, depth)
            if depth > 64 then error("Group nesting exceeds the safety limit; no actions were registered.") end
            using(obs.obs_scene_enum_items(container), obs.sceneitem_list_release, function(items)
                for _, item in ipairs(items) do
                    local child = obs.obs_sceneitem_get_source(item)
                    if child then
                        local path = key_path .. "/" .. encode(obs.obs_sceneitem_get_id(item)) .. "/" .. encode(identity(child))
                        local label = label_path .. "/" .. obs.obs_source_get_name(child)
                        if obs.obs_sceneitem_is_group(item) then
                            local group = obs.obs_sceneitem_group_get_scene(item)
                            if group then walk(group, path, label, depth + 1) end
                        else
                            local category = source_kind(child)
                            if category then
                                visitor({key = path, label = label, category = category}, item, child)
                            end
                        end
                    end
                end
            end)
        end
        walk(scene, prefix, selected, 0)
        return true
    end)
end

local function remember(registration)
    using(obs.obs_hotkey_save(registration.id), obs.obs_data_array_release, function(array)
        obs.obs_data_set_array(bindings, registration.key, array)
    end)
end

local function remove_registration(key)
    local registration = registrations[key]
    remember(registration)
    obs.obs_hotkey_unregister(registration.id)
    registrations[key] = nil
end

local media_apis = {
    Play = "obs_source_media_play_pause", Pause = "obs_source_media_play_pause",
    Restart = "obs_source_media_restart", Stop = "obs_source_media_stop",
}

local function perform(descriptor, action)
    if not enabled or not ready then return end
    -- First pass validates the exact occurrence (UUID + container + item ID),
    -- including its display path. Stale callbacks never act on replacements.
    local found = descriptor.common
    local valid = visit_scene(function(current)
        if current.key == descriptor.key and current.label == descriptor.label then found = true end
    end)
    if not valid or not found then
        warn_once("A hotkey target changed or disappeared. Registrations refreshed; retry after checking Settings > Hotkeys.")
        rescan()
        return
    end
    visit_scene(function(current, item, source)
        if descriptor.common then
            if current.category == descriptor.category then obs.obs_sceneitem_set_visible(item, false) end
        elseif current.key == descriptor.key then
            if action == "Show" or action == "Hide" then
                obs.obs_sceneitem_set_visible(item, action == "Show")
            else
                local api = media_apis[action]
                if type(obs[api]) ~= "function" then
                    warn_once(action .. " is not available in this OBS Lua build.")
                elseif action == "Play" or action == "Pause" then
                    obs[api](source, action == "Pause")
                else
                    obs[api](source)
                end
            end
        elseif action == "Show" and current.category == descriptor.category then
            if (current.category == "video" and exclusive_video)
                or (current.category == "picture" and exclusive_picture) then
                obs.obs_sceneitem_set_visible(item, false)
            end
        end
    end)
end

local function register(descriptor, action, desired)
    local key = descriptor.key .. "/" .. encode(action)
    local label = "Emberstage · " .. descriptor.label .. " · " .. action
    desired[key] = true
    local previous = registrations[key]
    if previous and previous.label == label then return end
    if previous then remove_registration(key) end
    local callback = function(pressed)
        if not pressed then return end
        guarded(function() perform(descriptor, action) end)
    end
    local id = obs.obs_hotkey_register_frontend(key, label, callback)
    if id == nil or id == obs.OBS_INVALID_HOTKEY_ID then
        error("Could not register " .. label)
    end
    -- Retain the Lua callback for the entire registration lifetime.
    registrations[key] = {key = key, id = id, label = label, callback = callback}
    using(obs.obs_data_get_array(bindings, key), obs.obs_data_array_release, function(array)
        obs.obs_hotkey_load(id, array)
    end)
end

rescan = function()
    if not loaded then return end
    local discovered, desired = {}, {}
    local valid = false
    local ok = guarded(function()
        valid = visit_scene(function(descriptor) discovered[#discovered + 1] = descriptor end)
    end)
    ready = false
    if ok and valid then
        ok = guarded(function()
            for _, descriptor in ipairs(discovered) do
                register(descriptor, "Show", desired)
                register(descriptor, "Hide", desired)
                if descriptor.category == "video" then
                    for _, action in ipairs({"Play", "Pause", "Restart", "Stop"}) do
                        if type(obs[media_apis[action]]) == "function" then
                            register(descriptor, action, desired)
                        else
                            warn_once(action .. " API unavailable; that hotkey is omitted.")
                        end
                    end
                end
            end
            local root = "media_deck/v1/" .. encode(selected) .. "/" .. encode(pinned_identity)
            register({key = root .. "/all-pictures", label = selected, category = "picture", common = true}, "Hide pictures", desired)
            register({key = root .. "/all-video", label = selected, category = "video", common = true}, "Hide video", desired)
            register({key = root .. "/all-cameras", label = selected, category = "camera", common = true}, "Hide cameras", desired)
        end)
    end
    -- On a failed scan, fail closed rather than leaving partially valid actions armed.
    if not ok or not valid then desired = {} end
    local obsolete = {}
    for key in pairs(registrations) do
        if not desired[key] then obsolete[#obsolete + 1] = key end
    end
    for _, key in ipairs(obsolete) do guarded(function() remove_registration(key) end) end
    ready = ok and valid
    if ready then
        status = tostring(#discovered) .. " supported scene items. " .. (enabled and "Armed." or "Disarmed.")
    else
        status = "Disabled: choose an existing output scene. Re-scan after scene changes."
        if selected ~= "" then warn_once(status) end
    end
end

function script_description()
    return "<b>Emberstage · Native hotkeys</b><br>1. Choose your output scene.<br>2. Assign keys in Settings &gt; Hotkeys (search Emberstage).<br>3. Enable to arm.<br><br>No keys are assigned automatically. Only key presses act. No scene switching, browser reloads, or Scripture/Songs key bridge."
end

local function help(property, text)
    if type(obs.obs_property_set_long_description) == "function" then
        obs.obs_property_set_long_description(property, text)
    end
end

function script_properties()
    local props = obs.obs_properties_create()
    local output = obs.obs_properties_add_list(props, "output_scene", "Output scene", obs.OBS_COMBO_TYPE_LIST, obs.OBS_COMBO_FORMAT_STRING)
    obs.obs_property_list_add_string(output, "— Choose a scene (disabled) —", "")
    local found = false
    guarded(function()
        using(obs.obs_frontend_get_scenes(), obs.source_list_release, function(scenes)
            for _, source in ipairs(scenes) do
                local name = obs.obs_source_get_name(source)
                obs.obs_property_list_add_string(output, name, name)
                if name == selected then found = true end
            end
        end)
    end)
    if selected ~= "" and not found then
        obs.obs_property_list_add_string(output, "Missing: " .. selected .. " (disabled)", selected)
    end
    help(output, "Choose explicitly. Match the app's shared output scene manually; this script does not read or change app connection settings. A missing scene disables every action.")
    local arm = obs.obs_properties_add_bool(props, "enabled", "Enabled — arm native hotkeys")
    help(arm, "Off: all Emberstage keys do nothing. On: keys change items in the chosen scene, even when OBS is not focused. OBS Hotkey Focus Behavior and OS restrictions still apply.")
    local video = obs.obs_properties_add_bool(props, "exclusive_video", "Exclusive videos")
    help(video, "Off by default. When on, Show hides other video items in this scene and its groups. Cameras, captures and pictures are untouched.")
    local picture = obs.obs_properties_add_bool(props, "exclusive_picture", "Exclusive pictures")
    help(picture, "Off by default to preserve logos. When on, Show hides all other image/slideshow items in this scene and its groups, including logos.")
    obs.obs_properties_add_button(props, "rescan", "Re-scan sources", function()
        rescan()
        return true
    end)
    if obs.OBS_TEXT_INFO and type(obs.obs_properties_add_text) == "function" then
        obs.obs_properties_add_text(props, "status", status, obs.OBS_TEXT_INFO)
    end
    return props
end

function script_defaults(settings)
    obs.obs_data_set_default_string(settings, "output_scene", "")
    obs.obs_data_set_default_bool(settings, "enabled", false)
    obs.obs_data_set_default_bool(settings, "exclusive_video", false)
    obs.obs_data_set_default_bool(settings, "exclusive_picture", false)
end

function script_update(settings)
    local next_scene = obs.obs_data_get_string(settings, "output_scene")
    if next_scene ~= selected then pinned_identity = "" end
    selected = next_scene
    enabled = obs.obs_data_get_bool(settings, "enabled")
    exclusive_video = obs.obs_data_get_bool(settings, "exclusive_video")
    exclusive_picture = obs.obs_data_get_bool(settings, "exclusive_picture")
    if loaded then rescan() end
end

function script_load(settings)
    -- Required APIs are checked once. A reduced scripting build fails safely.
    local required = {
        "obs_get_source_by_name", "obs_source_release", "obs_source_get_name", "obs_source_get_id",
        "obs_scene_from_source", "obs_scene_enum_items", "sceneitem_list_release",
        "obs_sceneitem_get_source", "obs_sceneitem_get_id", "obs_sceneitem_is_group",
        "obs_sceneitem_group_get_scene", "obs_sceneitem_set_visible",
        "obs_hotkey_register_frontend", "obs_hotkey_unregister", "obs_hotkey_save", "obs_hotkey_load",
        "obs_data_get_array", "obs_data_set_array", "obs_data_array_release",
        "obs_data_get_obj", "obs_data_create", "obs_data_set_obj", "obs_data_release",
    }
    for _, api in ipairs(required) do
        if type(obs[api]) ~= "function" then
            status = "Disabled: missing OBS Lua API " .. api
            log(status)
            return
        end
    end
    bindings = obs.obs_data_get_obj(settings, "media_deck_bindings") or obs.obs_data_create()
    script_update(settings)
    pinned_identity = obs.obs_data_get_string(settings, "output_scene_identity")
    loaded = true
    rescan()
    if type(obs.timer_add) == "function" and type(obs.timer_remove) == "function" then
        obs.timer_add(rescan, 2000)
        watching = true
    else
        warn_once("Automatic source refresh unavailable. Use Re-scan sources after edits. Every key press still revalidates its target.")
    end
end

function script_save(settings)
    if not bindings then return end
    guarded(function()
        for _, registration in pairs(registrations) do remember(registration) end
        obs.obs_data_set_obj(settings, "media_deck_bindings", bindings)
        obs.obs_data_set_string(settings, "output_scene_identity", pinned_identity)
    end)
end

function script_unload()
    enabled, ready, loaded = false, false, false
    if watching then guarded(function() obs.timer_remove(rescan) end); watching = false end
    local keys = {}
    for key in pairs(registrations) do keys[#keys + 1] = key end
    for _, key in ipairs(keys) do guarded(function() remove_registration(key) end) end
    if bindings then obs.obs_data_release(bindings); bindings = nil end
end
