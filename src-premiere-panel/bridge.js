// VibeCut Agent's side inside Premiere Pro (PLAN.md, Phase 3). Adapted from VibeCut's
// src-premiere-panel/bridge.js (panel 0.9.4), with its own bundle id and folder so it runs alongside
// VibeCut's panel without sharing a queue.
//
// The agent's premiere-watch sidecar writes one request at a time to BRIDGE_DIR/jobs/<id>.json:
// {id, command, args}. This panel takes it, checks it, runs it through the one host.jsx function its
// command names, and writes {id, ok, result} or {id, ok: false, error} to BRIDGE_DIR/replies/<id>.json.
// It writes alive.json every second so the agent knows Premiere has loaded the panel; `instance` is
// new each time the panel loads, which is how a Premiere restart is told apart from a hiccup. There is
// no network port; only a fixed list of commands runs, and a request's arguments reach ExtendScript as
// a JSON literal, never as code.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PANEL_VERSION = "0.8.0";
// At most this many Level keys in one set_fades item (VibeCut 13e: a duck under speech is 4 per dip).
const MAX_LEVEL_KEYS = 400;
const BRIDGE_DIR =
  process.env.VIBECUT_AGENT_PREMIERE_BRIDGE_DIR ||
  path.join(os.homedir(), "Library", "Application Support", "VibeCut Agent", "host-bridge", "premiere");
const JOBS = path.join(BRIDGE_DIR, "jobs");
const REPLIES = path.join(BRIDGE_DIR, "replies");
const ALIVE = path.join(BRIDGE_DIR, "alive.json");
// Rebuilt sequences (Phase 6b): the only folder import_sequence takes a file from.
const IMPORTS = path.join(BRIDGE_DIR, "imports");
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const INSTANCE = crypto.randomBytes(8).toString("hex");
const STARTED_AT = Date.now() / 1000;

// command -> the host.jsx function that carries it out. Nothing else can be called.
const COMMANDS = {
  status: "vcStatus",
  sequence_info: "vcSequenceInfo",
  read_sequence: "vcReadSequence",
  add_markers: "vcAddMarkers",
  update_marker: "vcUpdateMarker",
  remove_markers: "vcRemoveMarkers",
  get_playhead: "vcGetPlayhead",
  set_playhead: "vcSetPlayhead",
  // Direct edits (Phase 4b), as VibeCut's panel names them.
  backup_sequence: "vcBackupSequence",
  place_clip: "vcPlaceClip",
  remove_items: "vcRemoveItems",
  nest_range: "vcNestRange",
  set_items: "vcSetItems",
  move_items: "vcMoveItems",
  link_items: "vcLinkItems",
  add_tracks: "vcAddTracks",
  remove_tracks: "vcRemoveTracks",
  read_fades: "vcReadFades",
  set_fades: "vcSetFades",
  razor: "vcRazor",
  import_media: "vcImportMedia",
  source_preview: "vcSourcePreview",
  // Phase 6a: the project (sequences, selection, the Project panel).
  create_sequence: "vcCreateSequence",
  duplicate_sequence: "vcDuplicateSequence",
  open_sequence: "vcOpenSequence",
  rename_sequence: "vcRenameSequence",
  select_items: "vcSelectItems",
  select_project_items: "vcSelectProjectItems",
  read_project: "vcReadProject",
  project_item_info: "vcProjectItemInfo",
  // Phase 6b: a draft becomes a new sequence (premiere_rebuild.py writes the XML into imports/).
  import_sequence: "vcImportSequence",
  // Phase 6c: link groups (links.py), for link_clips and a synced camera + recorder.
  set_links: "vcSetLinks",
};

// Premiere's own sequence presets only (premiere_project.preset_for picks one).
const SEQUENCE_PRESET = /^\/Applications\/Adobe Premiere Pro [^/]+\/Adobe Premiere Pro [^/]+\.app\/Contents\/Settings\/SequencePresets\/.+\.sqpreset$/;

// A sequence's name: one line of at most 200 characters.
function checkSequenceName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\r\n]/.test(value)) {
    throw new Error("timeline must name a sequence in one short line");
  }
}

// A project item's or bin's nodeId.
function checkId(value, where) {
  if (typeof value !== "string" || !/^[\w-]{1,64}$/.test(value)) throw new Error(`${where} must be a project item id`);
}

function checkIds(value, where) {
  if (!Array.isArray(value) || !value.length || value.length > 500) throw new Error(`${where} must list 1 to 500 project item ids`);
  value.forEach((id, i) => checkId(id, `${where}[${i}]`));
}

// One line of at most 255 characters; a bin's name can't hold "/", which VibeCut's bin paths use.
function checkName(value, where, isBin) {
  if (typeof value !== "string" || !value.trim() || value.length > 255 || /[\r\n]/.test(value) || (isBin && value.includes("/"))) {
    throw new Error(`${where} must be one line of at most 255 characters${isBin ? ', without "/"' : ""}`);
  }
}

function checkTicks(value, where) {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) throw new Error(`${where} must be ticks`);
}

function checkText(value, where) {
  if (typeof value !== "string" || value.length > 2000) throw new Error(`${where} must be text`);
}

function checkMarkerId(value, where) {
  if (typeof value !== "string" || !/^[\w-]{1,64}$/.test(value)) throw new Error(`${where} must be a marker id`);
}

function checkSeconds(value, where) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${where} must be seconds`);
}

function checkColor(value, where) {
  if (!Number.isInteger(value) || value < 0 || value > 7) throw new Error(`${where} must be a marker color index`);
}

// Checks beyond plain JSON, per command. The sidecar (nle/premiere.py) has already checked meaning;
// these keep anything malformed from reaching ExtendScript.
function checkMediaFile(file, where) {
  if (typeof file !== "string" || !path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${where} must be an existing media file`);
  }
}

const CHECKS = {
  set_links(args) {
    checkSequenceName(args.timeline);
    if (!Array.isArray(args.unlink) || args.unlink.length > 64) throw new Error("unlink must list at most 64 clips");
    args.unlink.forEach((id, i) => checkId(id, `unlink[${i}]`));
    if (!Array.isArray(args.groups) || args.groups.length > 32) throw new Error("groups must list at most 32 groups");
    args.groups.forEach((group, g) => {
      if (!Array.isArray(group) || group.length < 2 || group.length > 64) throw new Error(`groups[${g}] must list 2 to 64 clips`);
      group.forEach((id, i) => checkId(id, `groups[${g}][${i}]`));
    });
  },
  import_sequence(args) {
    const file = args.path;
    if (typeof file !== "string" || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".xml") {
      throw new Error("path must be an absolute .xml path");
    }
    let real;
    try {
      real = fs.realpathSync(file);
    } catch (e) {
      throw new Error("path must be a rebuilt sequence that exists");
    }
    if (!fs.existsSync(IMPORTS) || path.dirname(real) !== fs.realpathSync(IMPORTS)) throw new Error("Only VibeCut Agent's own rebuilt sequences can be imported");
    if (typeof args.name !== "string" || !args.name.trim() || args.name.length > 200) throw new Error("name must be a short text");
    if (typeof args.bin !== "string" || !/^[\w ()-]{1,64}$/.test(args.bin)) throw new Error("bin must be a short name");
  },
  create_sequence(args) {
    checkSequenceName(args.name);
    const preset = args.preset;
    if (typeof preset !== "string" || !SEQUENCE_PRESET.test(preset) || preset.includes("..") || !fs.existsSync(preset)) {
      throw new Error("preset must be one of Premiere's own sequence presets");
    }
  },
  duplicate_sequence(args) {
    checkSequenceName(args.timeline);
    checkSequenceName(args.name);
  },
  open_sequence(args) {
    checkSequenceName(args.timeline);
  },
  rename_sequence(args) {
    checkSequenceName(args.timeline);
    checkSequenceName(args.name);
  },
  select_items(args) {
    checkSequenceName(args.timeline);
    if (!Array.isArray(args.ids) || args.ids.length > 64) throw new Error("ids must list at most 64 clips");
    args.ids.forEach((id, i) => checkId(id, `ids[${i}]`));
    if (typeof args.additive !== "boolean") throw new Error("additive must be true or false");
  },
  select_project_items(args) {
    if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 64) throw new Error("ids must list 1 to 64 project items");
    args.ids.forEach((id, i) => checkId(id, `ids[${i}]`));
  },
  read_project(args) {
    if (args.timeline !== undefined) checkSequenceName(args.timeline);
    if (args.usage !== undefined && typeof args.usage !== "boolean") throw new Error("usage must be true or false");
  },
  project_item_info(args) {
    checkId(args.id, "id");
  },
  import_media(args) {
    if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 50) throw new Error("paths must list 1 to 50 files");
    args.paths.forEach((file, i) => checkMediaFile(file, `paths[${i}]`));
    checkName(args.bin, "bin", true);
  },
  source_preview(args) {
    checkMediaFile(args.path, "path");
    const ok = (t) => typeof t === "number" && Number.isFinite(t) && t >= 0;
    if (!ok(args.inSeconds) || !ok(args.outSeconds) || args.outSeconds <= args.inSeconds) throw new Error("inSeconds and outSeconds must be a range");
  },
  sequence_info(args) {
    checkSequenceName(args.timeline);
  },
  read_sequence(args) {
    checkSequenceName(args.timeline);
    if (args.effects !== undefined && typeof args.effects !== "boolean") throw new Error("effects must be true or false");
  },
  add_markers(args) {
    checkSequenceName(args.timeline);
    if (!Array.isArray(args.markers) || !args.markers.length || args.markers.length > 500) throw new Error("markers must list 1 to 500 markers");
    args.markers.forEach((m, i) => {
      if (!isPlainObject(m)) throw new Error(`markers[${i}] must be an object`);
      checkTicks(m.ticks, `markers[${i}].ticks`);
      checkSeconds(m.seconds, `markers[${i}].seconds`);
      if (m.endSeconds !== null) checkSeconds(m.endSeconds, `markers[${i}].endSeconds`);
      checkText(m.name, `markers[${i}].name`);
      checkText(m.comments, `markers[${i}].comments`);
      checkColor(m.colorIndex, `markers[${i}].colorIndex`);
    });
  },
  update_marker(args) {
    checkSequenceName(args.timeline);
    checkMarkerId(args.id, "id");
    if (args.name !== undefined) checkText(args.name, "name");
    if (args.comments !== undefined) checkText(args.comments, "comments");
    if (args.colorIndex !== undefined) checkColor(args.colorIndex, "colorIndex");
    if (args.ticks !== undefined) {
      checkTicks(args.ticks, "ticks");
      checkSeconds(args.seconds, "seconds");
    }
  },
  remove_markers(args) {
    checkSequenceName(args.timeline);
    if (args.all === true) return;
    if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 500) throw new Error("ids must list 1 to 500 markers");
    args.ids.forEach((id, i) => checkMarkerId(id, `ids[${i}]`));
  },
  get_playhead(args) {
    checkSequenceName(args.timeline);
  },
  set_playhead(args) {
    checkSequenceName(args.timeline);
    checkTicks(args.ticks, "ticks");
  },
  // Copied from VibeCut's bridge.js.
  place_clip(args) {
    const file = args.path;
    if (typeof file !== "string" || !path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error("path must be an existing media file");
    }
    if (typeof args.bin !== "string" || !/^[\w ()-]{1,64}$/.test(args.bin)) throw new Error("bin must be a short name");
    if (args.itemId !== undefined) checkId(args.itemId, "itemId");
  },
  add_tracks(args) {
    for (const kind of ["video", "audio"]) {
      if (!Number.isInteger(args[kind]) || args[kind] < 0 || args[kind] > 8) throw new Error(`${kind} must be 0 to 8 tracks`);
    }
  },
  remove_tracks(args) {
    for (const kind of ["video", "audio"]) {
      const list = args[kind] || [];
      if (!Array.isArray(list) || list.length > 16 || !list.every((i) => Number.isInteger(i) && i >= 0 && i < 100)) throw new Error(`${kind} must list track indexes`);
    }
  },
  nest_range(args) {
    checkIds(args.ids, "ids");
    checkName(args.name, "name", true);
    for (const key of ["inTicks", "outTicks"]) {
      if (typeof args[key] !== "string" || !/^\d{1,20}$/.test(args[key])) throw new Error(`${key} must be ticks`);
    }
  },
  read_fades(args) {
    checkIds(args.ids, "ids");
  },
  set_fades(args) {
    if (!Array.isArray(args.items) || !args.items.length || args.items.length > 200) throw new Error("items must list 1 to 200 clips");
    args.items.forEach((item, i) => {
      checkId(item.id, `items[${i}].id`);
      // Fades need at most 4 keys; a duck under speech (PLAN.md, "13e") 4 per dip.
      if (!Array.isArray(item.keys) || item.keys.length > MAX_LEVEL_KEYS) throw new Error(`items[${i}].keys must list at most ${MAX_LEVEL_KEYS} keys`);
      item.keys.forEach((key, k) => {
        if (typeof key.ticks !== "string" || !/^\d{1,20}$/.test(key.ticks)) throw new Error(`items[${i}].keys[${k}].ticks must be ticks`);
        if (typeof key.value !== "number" || !Number.isFinite(key.value)) throw new Error(`items[${i}].keys[${k}].value must be a number`);
      });
      if (typeof item.value !== "number" || !Number.isFinite(item.value)) throw new Error(`items[${i}].value must be a number`);
    });
  },
  razor(args) {
    if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 32) throw new Error("ids must list 1 to 32 clips");
    args.ids.forEach((id, i) => checkId(id, `ids[${i}]`));
    if (typeof args.timecode !== "string" || !/^\d{2}:\d{2}:\d{2}:\d{2,3}$/.test(args.timecode)) throw new Error("timecode must be HH:MM:SS:FF");
  },
};

let busy = false;

function writeJson(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function ensureDirs() {
  fs.mkdirSync(JOBS, { recursive: true });
  fs.mkdirSync(REPLIES, { recursive: true });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Only what JSON can say, and nothing deeper than a request needs.
function checkValue(value, where, depth) {
  if (depth > 8) throw new Error(`${where} is nested too deeply`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!isFinite(value)) throw new Error(`${where} must be a finite number`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 5000) throw new Error(`${where} has too many items`);
    value.forEach((item, i) => checkValue(item, `${where}[${i}]`, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    Object.keys(value).forEach((key) => {
      if (!/^[A-Za-z][\w]{0,63}$/.test(key)) throw new Error(`${where} has an unexpected key`);
      checkValue(value[key], `${where}.${key}`, depth + 1);
    });
    return;
  }
  throw new Error(`${where} has a value JSON can't carry`);
}

function checkedRequest(raw) {
  if (!isPlainObject(raw) || typeof raw.id !== "string" || !/^[\w-]{1,64}$/.test(raw.id)) {
    throw new Error("The request id must be a short word");
  }
  if (typeof raw.command !== "string" || !Object.prototype.hasOwnProperty.call(COMMANDS, raw.command)) {
    throw new Error(`Unknown command: ${String(raw.command).slice(0, 64)}`);
  }
  const args = raw.args === undefined ? {} : raw.args;
  if (!isPlainObject(args)) throw new Error("args must be an object");
  checkValue(args, "args", 0);
  if (CHECKS[raw.command]) CHECKS[raw.command](args);
  return { id: raw.id, command: raw.command, args };
}

// host.jsx is loaded at startup (manifest ScriptPath) and again before every request, so an updated
// panel takes effect without restarting Premiere.
function hostScriptPath() {
  const url = window.__adobe_cep__.getSystemPath("extension");
  return path.join(decodeURIComponent(url.replace(/^file:\/\//, "")), "host.jsx");
}

// JSON is an ExtendScript (ES3) literal, except that ES3 strings can't hold U+2028 and U+2029.
function literal(value) {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function evalScript(script) {
  return new Promise((resolve) => window.__adobe_cep__.evalScript(script, resolve));
}

function message(e) {
  return String(e && e.message ? e.message : e);
}

async function runOne(file) {
  const running = file + ".running";
  let id = path.basename(file, ".json");
  try {
    fs.renameSync(file, running);
  } catch (e) {
    return; // taken or withdrawn (the agent gave up waiting)
  }
  let reply;
  try {
    if (fs.statSync(running).size > MAX_REQUEST_BYTES) throw new Error("The request is too large");
    const request = checkedRequest(JSON.parse(fs.readFileSync(running, "utf8")));
    id = request.id;
    const fn = COMMANDS[request.command];
    const answer = await evalScript(`$.evalFile(${literal(hostScriptPath())}); ${fn}(${literal(request.args)})`);
    try {
      const parsed = JSON.parse(answer);
      reply =
        parsed && parsed.ok === true
          ? { id, ok: true, result: parsed.result }
          : { id, ok: false, error: String((parsed && parsed.error) || "Premiere couldn't do that") };
    } catch (e) {
      reply = { id, ok: false, error: `Premiere returned something that isn't JSON: ${String(answer).slice(0, 500)}` };
    }
  } catch (e) {
    reply = { id, ok: false, error: message(e) };
  } finally {
    try {
      fs.unlinkSync(running);
    } catch (e) {
      // Already gone.
    }
  }
  if (/^[\w-]{1,64}$/.test(id)) writeJson(path.join(REPLIES, `${id}.json`), reply);
}

async function poll() {
  if (busy) return;
  busy = true;
  try {
    const files = fs
      .readdirSync(JOBS)
      .filter((name) => /^[\w-]{1,64}\.json$/.test(name))
      .map((name) => path.join(JOBS, name))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    for (const file of files) await runOne(file);
  } catch (e) {
    ensureDirs();
  } finally {
    busy = false;
  }
}

function hostVersion() {
  try {
    return JSON.parse(window.__adobe_cep__.getHostEnvironment()).appVersion || null;
  } catch (e) {
    return null;
  }
}

function heartbeat() {
  try {
    writeJson(ALIVE, {
      time: Date.now() / 1000,
      busy,
      panelVersion: PANEL_VERSION,
      premiereVersion: hostVersion(),
      instance: INSTANCE,
      startedAt: STARTED_AT,
    });
  } catch (e) {
    ensureDirs(); // the folder was removed; the next beat writes again
  }
}

ensureDirs();
// A request left half-done by a Premiere that quit is answered by nobody; the agent has given up on it.
for (const name of fs.readdirSync(JOBS)) {
  if (name.endsWith(".running")) fs.unlinkSync(path.join(JOBS, name));
}
heartbeat();
setInterval(heartbeat, 1000);
setInterval(poll, 100);
try {
  fs.watch(JOBS, () => void poll());
} catch (e) {
  // The interval alone still picks requests up.
}
