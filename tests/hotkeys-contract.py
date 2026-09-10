"""Offline Lua contract checks; standard library only. Never starts OBS.

Uses the installed Lua 5.1/LuaJIT DLL as a language runtime, NOT obslua.dll.
All OBS interactions below are mocked. Native integration is a separate gate.
"""

import ctypes
import json
import os
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
DLL = Path(os.environ.get(
    "MEDIA_DECK_LUA_DLL",
    r"C:\Program Files\obs-studio\bin\64bit\lua51.dll",
))

CONTRACT = r'''
local function clone(value)
    if type(value) ~= "table" then return value end
    local result = {}
    for k, v in pairs(value) do result[k] = clone(v) end
    return result
end

local passed = 0
local function check(condition, message)
    if not condition then error(message, 2) end
end
local function test(name, fn)
    fn()
    passed = passed + 1
    print("PASS " .. name)
end

local world, obs, settings, live, logs, changes, refs, timer, next_id
local function source(name, kind, uuid)
    return {name = name, kind = kind, uuid = uuid}
end
local function item(id, src, visible)
    return {id = id, source = src, visible = visible ~= false}
end
local function initialize(options)
    options = options or {}
    live, logs, changes = {}, {}, {}
    refs = {sources = 0, lists = 0, arrays = 0, data = 0, scene_lists = 0}
    timer, next_id = nil, 0
    local root = source("Customer Output", "scene", "root-uuid")
    root.items = {}
    local group = source("Visuals", "group", "group-uuid")
    group.items = {}
    local nested = source("Nested", "group", "nested-uuid")
    nested.items = {}
    local cams, pictures = {}, {}
    for i = 1, 5 do
        cams[i] = item(100 + i, source("User Camera " .. i, "dshow_input", "camera-" .. i))
        root.items[#root.items + 1] = cams[i]
    end
    for i = 1, 24 do
        pictures[i] = item(200 + i, source("User Picture " .. i, "image_source", "picture-" .. i))
        local list = i <= 12 and group.items or nested.items
        list[#list + 1] = pictures[i]
    end
    local logo = item(300, source("Brand", "image_source", "logo-uuid"))
    root.items[#root.items + 1] = logo
    group.items[#group.items + 1] = item(2, nested)
    root.items[#root.items + 1] = item(1, group, false)
    local media = item(400, source("Clip", "ffmpeg_source", "clip-uuid"))
    local vlc = item(401, source("Playlist", "vlc_source", "vlc-uuid"))
    root.items[#root.items + 1] = media
    root.items[#root.items + 1] = vlc
    for i, kind in ipairs({"window_capture", "game_capture", "monitor_capture", "slideshow"}) do
        root.items[#root.items + 1] = item(500 + i, source(kind, kind, "extra-" .. i))
    end
    root.items[#root.items + 1] = item(600, source("Overlay", "browser_source", "browser-uuid"))
    root.items[#root.items + 1] = item(601, source("Audio", "wasapi_input_capture", "audio-uuid"))
    local outside = source("Different scene", "scene", "outside-uuid")
    outside.items = {item(200, pictures[1].source)}
    root.items[#root.items + 1] = item(700, outside) -- no nested scene expansion
    world = {root = root, group = group, nested = nested, cameras = cams,
        pictures = pictures, logo = logo, media = media, vlc = vlc, outside = outside,
        sources = {[root.name] = root, [outside.name] = outside}}
    obs = {LOG_WARNING = 1, OBS_INVALID_HOTKEY_ID = -1,
        OBS_COMBO_TYPE_LIST = 2, OBS_COMBO_FORMAT_STRING = 3, OBS_TEXT_INFO = 4}
    obs.script_log = function(_, text) logs[#logs + 1] = text end
    obs.obs_source_get_name = function(s) return s.name end
    obs.obs_source_get_id = function(s) return s.kind end
    obs.obs_source_get_unversioned_id = obs.obs_source_get_id
    if not options.no_uuid then obs.obs_source_get_uuid = function(s) return s.uuid end end
    obs.obs_get_source_by_name = function(name)
        local src = world.sources[name]
        if src then refs.sources = refs.sources + 1 end
        return src
    end
    obs.obs_source_release = function(_) refs.sources = refs.sources - 1 end
    obs.obs_scene_from_source = function(s) if s.kind == "scene" then return s end end
    obs.obs_scene_enum_items = function(s)
        if s.fail_enum then error("simulated nested enumeration failure") end
        refs.lists = refs.lists + 1
        return s.items
    end
    obs.sceneitem_list_release = function(_) refs.lists = refs.lists - 1 end
    obs.obs_sceneitem_get_source = function(i) return i.source end
    obs.obs_sceneitem_get_id = function(i) return i.id end
    obs.obs_sceneitem_is_group = function(i) return i.source.kind == "group" end
    obs.obs_sceneitem_group_get_scene = function(i) return i.source end
    obs.obs_sceneitem_set_visible = function(i, visible)
        i.visible = visible
        changes[#changes + 1] = {item = i, visible = visible}
    end
    obs.obs_frontend_get_scenes = function()
        refs.scene_lists = refs.scene_lists + 1
        return {world.outside, world.root} -- wrong scene deliberately first
    end
    obs.source_list_release = function(_) refs.scene_lists = refs.scene_lists - 1 end
    obs.obs_hotkey_register_frontend = function(key, label, callback)
        next_id = next_id + 1
        live[next_id] = {key = key, label = label, callback = callback, binding = {}}
        return next_id
    end
    obs.obs_hotkey_unregister = function(id) live[id] = nil end
    obs.obs_hotkey_save = function(id)
        refs.arrays = refs.arrays + 1
        return clone(live[id].binding)
    end
    obs.obs_hotkey_load = function(id, array) live[id].binding = clone(array) end
    obs.obs_data_get_array = function(data, key)
        refs.arrays = refs.arrays + 1
        return clone(data[key] or {})
    end
    obs.obs_data_set_array = function(data, key, array) data[key] = clone(array) end
    obs.obs_data_array_release = function(_) refs.arrays = refs.arrays - 1 end
    obs.obs_data_create = function() refs.data = refs.data + 1; return {} end
    obs.obs_data_get_obj = function(data, key)
        if data[key] then refs.data = refs.data + 1; return data[key] end
    end
    obs.obs_data_set_obj = function(data, key, object) data[key] = object end
    obs.obs_data_release = function(_) refs.data = refs.data - 1 end
    obs.obs_data_get_string = function(data, key) return data[key] or "" end
    obs.obs_data_get_bool = function(data, key) return data[key] == true end
    obs.obs_data_set_string = function(data, key, value) data[key] = value end
    obs.obs_data_set_default_string = function(data, key, value) if data[key] == nil then data[key] = value end end
    obs.obs_data_set_default_bool = obs.obs_data_set_default_string
    obs.timer_add = function(fn, ms) check(ms == 2000, "refresh interval"); timer = fn end
    obs.timer_remove = function(fn) check(timer == fn, "correct timer removed"); timer = nil end
    for _, name in ipairs({"play_pause", "restart", "stop"}) do
        obs["obs_source_media_" .. name] = function(src, arg)
            changes[#changes + 1] = {media = src, action = name, arg = arg}
        end
    end
    obs.obs_properties_create = function() return {} end
    local function property(props, key, label)
        props[key] = {label = label, entries = {}}
        return props[key]
    end
    obs.obs_properties_add_list = property
    obs.obs_properties_add_bool = property
    obs.obs_properties_add_text = property
    obs.obs_properties_add_button = function(props, key, label, callback)
        local p = property(props, key, label); p.callback = callback; return p
    end
    obs.obs_property_set_long_description = function(p, help) p.help = help end
    obs.obs_property_list_add_string = function(p, label, value)
        p.entries[#p.entries + 1] = {label = label, value = value}
    end
    obslua = obs
    dofile(SCRIPT)
    settings = {}
    script_defaults(settings)
end

local function count()
    local n = 0
    for _ in pairs(live) do n = n + 1 end
    return n
end
local function find(suffix)
    for _, registration in pairs(live) do
        if registration.label:sub(-#suffix) == suffix then return registration end
    end
    error("Missing hotkey: " .. suffix)
end
local function fire(suffix, pressed) find(suffix).callback(pressed ~= false) end
local function load_armed()
    settings.output_scene = world.root.name
    settings.enabled = true
    script_load(settings)
end
local function balanced()
    for key, value in pairs(refs) do check(value == 0, key .. " leaked: " .. value) end
    check(count() == 0, "registrations leaked")
    check(timer == nil, "timer leaked")
end
local function finish() script_unload(); balanced() end

test("explicit scene choice, defaults, and minimal properties", function()
    initialize()
    script_load(settings)
    check(count() == 0 and #changes == 0, "blank selection acted")
    check(not settings.enabled and not settings.exclusive_video and not settings.exclusive_picture, "unsafe defaults")
    local props = script_properties()
    check(props.output_scene.entries[1].value == "", "blank must be first")
    check(props.enabled and props.exclusive_video and props.exclusive_picture and props.rescan, "missing properties")
    settings.output_scene = "Missing scene"
    script_update(settings)
    props = script_properties()
    check(props.output_scene.entries[#props.output_scene.entries].value == "Missing scene", "missing selection not retained")
    check(count() == 0 and #changes == 0, "missing scene fell back")
    finish()
end)

test("dynamic 5 cameras, 24 pictures, nested groups, supported types only", function()
    initialize(); load_armed()
    -- 5 cameras + 24 pictures + logo + slideshow + 3 captures = 34 * 2;
    -- 2 media sources * 6; 3 common hide keys = 83.
    check(count() == 83, "unexpected dynamic registration count: " .. count())
    find("Visuals/Nested/User Picture 24 · Show")
    find("User Camera 5 · Hide")
    check(#changes == 0, "load mutated scene")
    for _, reg in pairs(live) do
        check(next(reg.binding) == nil, "default binding assigned")
        check(not reg.label:find("Overlay") and not reg.label:find("Audio"), "overlay/audio classified")
        reg.callback(false)
    end
    check(#changes == 0, "release event mutated scene")
    timer(); script_properties().rescan.callback()
    check(#changes == 0 and count() == 83, "rescan mutated or duplicated")
    finish()
end)

test("Show/Hide scoped to occurrence; exclusivity off preserves logos and groups", function()
    initialize(); load_armed()
    fire("User Picture 1 · Show")
    check(#changes == 1 and changes[1].item == world.pictures[1], "Show touched peers")
    check(world.logo.visible, "logo hidden")
    check(not world.root.items[7].visible, "hidden group was revealed")
    changes = {}
    fire("User Picture 1 · Hide")
    check(#changes == 1 and not world.pictures[1].visible, "Hide not scoped")
    check(world.outside.items[1].visible, "other scene occurrence changed")
    fire("Clip · Show")
    check(world.vlc.visible, "exclusive video default unsafe")
    finish()
end)

test("exclusive opt-ins touch only peers in the selected category", function()
    initialize(); load_armed()
    settings.exclusive_picture = true; script_update(settings)
    fire("User Picture 24 · Show")
    check(world.pictures[24].visible and not world.pictures[1].visible, "picture exclusivity failed")
    check(not world.logo.visible, "logo should be a picture peer when explicitly exclusive")
    check(world.cameras[1].visible and world.media.visible, "unrelated category hidden")
    settings.exclusive_video = true; script_update(settings)
    fire("Clip · Show")
    check(world.media.visible and not world.vlc.visible and world.pictures[24].visible, "video exclusivity crossed category")
    check(world.outside.items[1].visible, "other scene hidden")
    finish()
end)

test("common hide actions and disarm press guards", function()
    initialize(); load_armed()
    settings.enabled = false; script_update(settings)
    for _, reg in pairs(live) do reg.callback(true) end
    check(#changes == 0, "disarmed key acted")
    settings.enabled = true; script_update(settings)
    fire("Customer Output · Hide pictures")
    check(not world.logo.visible and not world.pictures[24].visible, "common picture hide incomplete")
    check(world.media.visible and world.cameras[1].visible, "common picture hide crossed category")
    fire("Customer Output · Hide video")
    check(not world.media.visible and not world.vlc.visible, "common video hide incomplete")
    check(world.cameras[1].visible and world.outside.items[1].visible, "common hide escaped scope")
    finish()
end)

test("native media operations do not show items or run on release", function()
    initialize(); load_armed()
    for _, name in ipairs({"Clip", "Playlist"}) do
        fire(name .. " · Play"); check(changes[#changes].arg == false, "Play must unpause")
        fire(name .. " · Pause"); check(changes[#changes].arg == true, "Pause must pause")
        fire(name .. " · Restart"); check(changes[#changes].action == "restart", "Restart not native")
        fire(name .. " · Stop"); check(changes[#changes].action == "stop", "Stop not native")
    end
    check(#changes == 8, "unexpected media mutations")
    for _, change in ipairs(changes) do check(change.item == nil, "media control changed visibility") end
    finish()
end)

test("reorder and UUID rename preserve identity/bindings; stale labels skip", function()
    initialize(); load_armed()
    local before = find("User Picture 1 · Show")
    before.binding = {{key = "OBS_KEY_F15", control = true}}
    local key = before.key
    local moved = table.remove(world.group.items, 1)
    world.group.items[#world.group.items + 1] = moved
    timer()
    check(find("User Picture 1 · Show").key == key, "array order changed identity")
    world.pictures[1].source.name = "Renamed Picture"
    world.group.name = "Renamed Group"
    before.callback(true)
    check(#changes == 0, "stale label acted before rescan")
    local after = find("Renamed Group/Renamed Picture · Show")
    check(after.key == key and after.binding[1].key == "OBS_KEY_F15", "rename lost binding")
    fire("Renamed Picture · Show")
    check(#changes == 1, "renamed action not usable")
    finish()
end)

test("same-source multiple occurrences have distinct stable keys", function()
    initialize(); load_armed()
    local existing = find("User Picture 1 · Show")
    world.nested.items[#world.nested.items + 1] = item(201, world.pictures[1].source)
    timer()
    local duplicate = find("Nested/User Picture 1 · Show")
    check(duplicate.key ~= existing.key, "container IDs not in key")
    duplicate.callback(true)
    check(#changes == 1 and changes[1].item ~= world.pictures[1], "wrong occurrence changed")
    finish()
end)

test("delete/replacement revalidation, saved archives, reload and cleanup", function()
    initialize(); load_armed()
    local old = find("Clip · Show")
    old.binding = {{key = "OBS_KEY_F16"}}
    local original = world.media.source
    world.media.source = source(original.name, original.kind, "replacement-uuid")
    old.callback(true)
    check(#changes == 0, "stale action touched replacement")
    check(next(find("Clip · Show").binding) == nil, "replacement inherited key")
    script_save(settings)
    check(settings.media_deck_bindings[old.key][1].key == "OBS_KEY_F16", "archived binding lost")
    world.media.source = original; timer()
    check(find("Clip · Show").binding[1].key == "OBS_KEY_F16", "restored identity lost key")
    script_save(settings); script_unload(); balanced()
    dofile(SCRIPT); script_load(settings)
    check(find("Clip · Show").binding[1].key == "OBS_KEY_F16", "reload lost key")
    check(#changes == 0, "save/reload mutated scene")
    world.sources[world.root.name] = nil
    timer()
    check(count() == 0, "deleted scene registrations not removed")
    old.callback(true)
    check(#changes == 0, "deleted scene action mutated")
    finish()
end)

test("same-name replacement output scene fails closed until explicit reselect", function()
    initialize(); load_armed()
    world.root.uuid = "replacement-root"
    timer()
    check(count() == 0 and #changes == 0, "replacement root silently accepted")
    settings.output_scene = ""; script_update(settings)
    settings.output_scene = world.root.name; script_update(settings)
    check(count() == 82, "explicit replacement selection failed")
    finish()
end)

test("missing optional APIs degrade safely and required APIs fail closed", function()
    initialize({no_uuid = true})
    obs.obs_source_media_restart = nil
    obs.timer_add, obs.timer_remove = nil, nil
    load_armed()
    check(count() == 80 and #logs >= 3, "missing APIs not explained/omitted")
    fire("User Camera 5 · Show")
    check(#changes == 1, "fallback identity failed")
    finish()
    initialize()
    obs.obs_sceneitem_group_get_scene = nil
    load_armed()
    check(count() == 0 and #logs > 0 and #changes == 0, "missing required API not safe")
    finish()
end)

test("nested enumeration failure releases resources and disables hotkeys", function()
    initialize(); load_armed()
    world.nested.fail_enum = true
    timer()
    check(count() == 0 and #changes == 0 and #logs > 0, "failed traversal did not fail closed")
    check(refs.sources == 0 and refs.lists == 0 and refs.arrays == 0, "exception leaked references")
    finish()
end)

print(string.format("%d contract tests passed (mock obslua; no native OBS integration).", passed))
'''


def main() -> int:
    if not DLL.is_file():
        print(f"SKIP: Lua 5.1 runtime not found: {DLL}")
        return 0
    try:
        lua = ctypes.CDLL(str(DLL))
    except OSError as error:
        print(f"SKIP: compatible Lua 5.1 runtime could not load: {error}")
        return 0

    pointer = ctypes.c_void_p
    lua.luaL_newstate.restype = pointer
    lua.luaL_openlibs.argtypes = [pointer]
    lua.luaL_loadbuffer.argtypes = [pointer, ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p]
    lua.luaL_loadbuffer.restype = ctypes.c_int
    lua.lua_pcall.argtypes = [pointer, ctypes.c_int, ctypes.c_int, ctypes.c_int]
    lua.lua_pcall.restype = ctypes.c_int
    lua.lua_tolstring.argtypes = [pointer, ctypes.c_int, ctypes.POINTER(ctypes.c_size_t)]
    lua.lua_tolstring.restype = ctypes.c_char_p
    lua.lua_close.argtypes = [pointer]
    state = lua.luaL_newstate()
    if not state:
        raise RuntimeError("Could not allocate Lua state")
    try:
        lua.luaL_openlibs(state)
        script = (ROOT / "scripts" / "media-deck-hotkeys.lua").as_posix()
        payload = ("SCRIPT = " + json.dumps(script, ensure_ascii=False) + "\n" + CONTRACT).encode("utf-8")
        result = lua.luaL_loadbuffer(state, payload, len(payload), b"hotkeys-contract")
        if result == 0:
            result = lua.lua_pcall(state, 0, 0, 0)
        if result:
            message = lua.lua_tolstring(state, -1, None)
            print("FAIL: " + (message.decode("utf-8", errors="replace") if message else "unknown Lua error"), file=sys.stderr)
            return 1
        return 0
    finally:
        lua.lua_close(state)


if __name__ == "__main__":
    raise SystemExit(main())
