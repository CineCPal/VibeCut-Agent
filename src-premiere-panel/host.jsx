// ExtendScript side of VibeCut Agent's Premiere panel (see bridge.js). Copied from VibeCut's
// src-premiere-panel/host.jsx (panel 0.9.4), keeping only what the connection layer reads (PLAN.md,
// Phases 3 and 4): status, sequence_info, read_sequence, markers, the playhead, and the direct edits
// (backup, place, remove, nest, levels and switches, moves, links, tracks, fades, razor) that
// src-python/vibecut_agent/nle/premiere_edit.py and friends drive.
//
// ES3: no JSON object and no Array.map, so both are done by hand. Each vc* function takes one plain
// object (a JSON literal written by bridge.js) and returns a JSON string, {ok: true, result} or
// {ok: false, error}. Times are ticks (strings, 254016000000 per second) and colours are Premiere's
// indexes; turning those into seconds and names is done by the sidecar
// (src-python/vibecut_agent/nle/premiere.py).

var VC_TICKS_PER_SECOND = 254016000000;

function vcQuote(s) {
  var out = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var code = s.charCodeAt(i);
    if (c === '"' || c === "\\") {
      out += "\\" + c;
    } else if (code < 32 || code === 0x2028 || code === 0x2029) {
      var hex = code.toString(16);
      out += "\\u" + "0000".substr(hex.length) + hex;
    } else {
      out += c;
    }
  }
  return out + '"';
}

function vcJson(v) {
  if (v === null || v === undefined) {
    return "null";
  }
  var t = typeof v;
  if (t === "number") {
    return isFinite(v) ? String(v) : "null";
  }
  if (t === "boolean") {
    return v ? "true" : "false";
  }
  if (t === "string") {
    return vcQuote(v);
  }
  var parts = [];
  if (v instanceof Array) {
    for (var i = 0; i < v.length; i++) {
      parts.push(vcJson(v[i]));
    }
    return "[" + parts.join(",") + "]";
  }
  for (var k in v) {
    if (v.hasOwnProperty(k)) {
      parts.push(vcQuote(k) + ":" + vcJson(v[k]));
    }
  }
  return "{" + parts.join(",") + "}";
}

// Runs one command body; an exception becomes {ok: false} with where it happened.
function vcAnswer(body, args) {
  try {
    return vcJson({ ok: true, result: body(args) });
  } catch (e) {
    var text = e && e.message ? e.message : String(e);
    return vcJson({ ok: false, error: e && e.vcPlain ? text : text + " (host.jsx line " + e.line + ")" });
  }
}

// An error meant for the user as it is, without a line number.
function vcRefuse(text) {
  var e = new Error(text);
  e.vcPlain = true;
  throw e;
}

function vcProject() {
  if (!app.project || !app.project.path) {
    vcRefuse("No project is open in Premiere Pro");
  }
  return app.project;
}

function vcProjectName(project) {
  return String(project.name).replace(/\.prproj$/i, "");
}

// Premiere lets two sequences share a name; VibeCut names them, so a shared name is refused.
function vcSequenceNamed(name) {
  var project = vcProject();
  var found = [];
  for (var i = 0; i < project.sequences.numSequences; i++) {
    if (project.sequences[i].name === name) {
      found.push(project.sequences[i]);
    }
  }
  if (found.length === 0) {
    vcRefuse("There is no sequence called \"" + name + "\" in the Premiere project \"" + vcProjectName(project) + "\" any more");
  }
  if (found.length > 1) {
    vcRefuse("There are " + found.length + " sequences called \"" + name + "\". Rename one in Premiere so VibeCut knows which to use");
  }
  return found[0];
}

function vcIsActive(sequence) {
  var active = app.project.activeSequence;
  return active ? active.sequenceID === sequence.sequenceID : false;
}

// ------------------------------------------------------------------------------ reading

// The raw Level of a clip's Volume effect (a gain; VibeCut turns it into dB), or null.
function vcLevel(clip) {
  for (var c = 0; c < clip.components.numItems; c++) {
    var component = clip.components[c];
    if (component.displayName !== "Volume") {
      continue;
    }
    for (var p = 0; p < component.properties.numItems; p++) {
      var prop = component.properties[p];
      if (prop.displayName === "Level") {
        return prop.getValue();
      }
    }
  }
  return null;
}

function vcLinkedIds(clip) {
  var ids = [];
  if (typeof clip.getLinkedItems !== "function") {
    return ids;
  }
  var partners = clip.getLinkedItems();
  if (!partners) {
    return ids;
  }
  for (var i = 0; i < partners.numItems; i++) {
    if (partners[i].nodeId !== clip.nodeId) {
      ids.push(partners[i].nodeId);
    }
  }
  return ids;
}

// Opacity and Motion as Premiere sets them on a clip nobody changed (checked in 26.5.2); by display name.
var VC_DEFAULT_VALUES = {
  Opacity: 100,
  Position: "0.5,0.5",
  Scale: 100,
  "Scale Width": 100,
  Rotation: 0,
  "Anchor Point": "0.5,0.5",
  "Anti-flicker Filter": 0,
  "Crop Left": 0,
  "Crop Top": 0,
  "Crop Right": 0,
  "Crop Bottom": 0
};

// Whether a picture clip has anything re-placing it from its project item would lose: an effect beyond
// Opacity and Motion, a changed Opacity or Motion value, or keyframes. Anything it can't read counts.
function vcHasEffects(clip) {
  try {
    for (var c = 0; c < clip.components.numItems; c++) {
      var component = clip.components[c];
      if (component.matchName !== "AE.ADBE Opacity" && component.matchName !== "AE.ADBE Motion") {
        return true;
      }
      for (var p = 0; p < component.properties.numItems; p++) {
        var prop = component.properties[p];
        if (typeof prop.isTimeVarying === "function" && prop.isTimeVarying()) {
          var keys = prop.getKeys();
          if (keys && keys.length > 1) {
            return true;
          }
        }
        if (VC_DEFAULT_VALUES.hasOwnProperty(prop.displayName)) {
          var value = prop.getValue();
          var shown = value instanceof Array ? value.join(",") : value;
          if (typeof shown === "number" ? Math.abs(shown - VC_DEFAULT_VALUES[prop.displayName]) > 0.0001 : String(shown) !== String(VC_DEFAULT_VALUES[prop.displayName])) {
            return true;
          }
        }
      }
    }
  } catch (e) {
    return true;
  }
  return false;
}

// effects: also say whether a picture clip has effects (custom), which reads every property.
function vcReadClip(clip, isAudio, effects) {
  var item = clip.projectItem;
  var isSequence = false;
  var mediaPath = null;
  if (item) {
    try {
      isSequence = item.isSequence();
    } catch (e1) {
      isSequence = false;
    }
    try {
      mediaPath = isSequence ? null : item.getMediaPath() || null;
    } catch (e2) {
      mediaPath = null;
    }
  }
  return {
    id: clip.nodeId,
    name: clip.name,
    startTicks: clip.start.ticks,
    endTicks: clip.end.ticks,
    inTicks: clip.inPoint.ticks,
    outTicks: clip.outPoint.ticks,
    disabled: clip.disabled === true,
    speed: typeof clip.getSpeed === "function" ? clip.getSpeed() : 1,
    reversed: typeof clip.isSpeedReversed === "function" ? clip.isSpeedReversed() === 1 : false,
    adjustment: typeof clip.isAdjustmentLayer === "function" ? clip.isAdjustmentLayer() === true : false,
    nested: isSequence,
    offline: item && typeof item.isOffline === "function" ? item.isOffline() === true : false,
    mediaPath: mediaPath,
    linkedIds: vcLinkedIds(clip),
    level: isAudio ? vcLevel(clip) : null,
    projectItemId: item ? item.nodeId : null,
    custom: effects && !isAudio ? vcHasEffects(clip) : null
  };
}

function vcReadTrack(track, isAudio, effects) {
  var clips = [];
  for (var c = 0; c < track.clips.numItems; c++) {
    clips.push(vcReadClip(track.clips[c], isAudio, effects));
  }
  var transitions = [];
  if (track.transitions) {
    for (var t = 0; t < track.transitions.numItems; t++) {
      var transition = track.transitions[t];
      transitions.push({ name: transition.name, startTicks: transition.start.ticks, endTicks: transition.end.ticks });
    }
  }
  return {
    name: track.name,
    muted: typeof track.isMuted === "function" ? track.isMuted() === true : false,
    locked: typeof track.isLocked === "function" ? track.isLocked() === true : false,
    targeted: typeof track.isTargeted === "function" ? track.isTargeted() === true : false,
    clips: clips,
    transitions: transitions
  };
}

function vcReadMarker(marker) {
  return {
    id: marker.guid,
    name: marker.name || "",
    comments: marker.comments || "",
    startTicks: marker.start.ticks,
    endTicks: marker.end.ticks,
    colorIndex: typeof marker.getColorByIndex === "function" ? marker.getColorByIndex() : 0,
    type: marker.type || "Comment"
  };
}

function vcMarkers(sequence) {
  var out = [];
  var markers = sequence.markers;
  var marker = markers.getFirstMarker();
  while (marker) {
    out.push(vcReadMarker(marker));
    marker = markers.getNextMarker(marker);
  }
  return out;
}

function vcMarkerWithId(sequence, id) {
  var markers = sequence.markers;
  var marker = markers.getFirstMarker();
  while (marker) {
    if (marker.guid === id) {
      return marker;
    }
    marker = markers.getNextMarker(marker);
  }
  return null;
}

function vcMarkerAtTicks(sequence, ticks, exceptId) {
  var markers = sequence.markers;
  var marker = markers.getFirstMarker();
  while (marker) {
    if (marker.start.ticks === String(ticks) && marker.guid !== exceptId) {
      return marker;
    }
    marker = markers.getNextMarker(marker);
  }
  return null;
}

function vcStatus(args) {
  return vcAnswer(function () {
    var info = { product: "Adobe Premiere Pro", version: String(app.version), project: null, projectPath: null, sequences: [], activeSequence: null };
    if (!app.project || !app.project.path) {
      return info;
    }
    info.project = vcProjectName(app.project);
    info.projectPath = app.project.path;
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      info.sequences.push(app.project.sequences[i].name);
    }
    if (app.project.activeSequence) {
      info.activeSequence = app.project.activeSequence.name;
    }
    return info;
  }, args);
}

// Rate, start and length only: what marker and playhead requests need, without reading every clip.
function vcSequenceInfo(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    return { timebase: String(sequence.timebase), zeroPoint: String(sequence.zeroPoint), endTicks: String(sequence.end), isActive: vcIsActive(sequence) };
  }, args);
}

// args: {timeline, effects?}.
function vcReadSequence(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var video = [];
    var audio = [];
    for (var v = 0; v < sequence.videoTracks.numTracks; v++) {
      video.push(vcReadTrack(sequence.videoTracks[v], false, a.effects === true));
    }
    for (var s = 0; s < sequence.audioTracks.numTracks; s++) {
      audio.push(vcReadTrack(sequence.audioTracks[s], true, false));
    }
    return {
      project: vcProjectName(app.project),
      name: sequence.name,
      timebase: String(sequence.timebase),
      zeroPoint: String(sequence.zeroPoint),
      endTicks: String(sequence.end),
      isActive: vcIsActive(sequence),
      video: video,
      audio: audio,
      markers: vcMarkers(sequence)
    };
  }, args);
}

// ------------------------------------------------------------------------------ markers


// args.markers: [{ticks, seconds, endSeconds|null, name, comments, colorIndex}]. A frame that
// already has a marker keeps it. A marker's start and end are set in seconds: Premiere refuses a
// Time object there ("Illegal Parameter type", 26.5.2).
function vcAddMarkers(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var added = [];
    var kept = [];
    var refused = [];
    for (var i = 0; i < a.markers.length; i++) {
      var wanted = a.markers[i];
      var existing = vcMarkerAtTicks(sequence, wanted.ticks, null);
      if (existing) {
        kept.push(existing.guid);
        continue;
      }
      var marker = sequence.markers.createMarker(wanted.seconds);
      if (!marker) {
        refused.push(wanted.ticks);
        continue;
      }
      marker.name = wanted.name;
      marker.comments = wanted.comments;
      if (wanted.endSeconds !== null && wanted.endSeconds !== undefined) {
        marker.end = wanted.endSeconds;
      }
      if (typeof marker.setColorByIndex === "function") {
        marker.setColorByIndex(wanted.colorIndex);
      }
      added.push(vcReadMarker(marker));
    }
    return { added: added, alreadyThere: kept, refusedAt: refused };
  }, args);
}

// args: {timeline, id, name?, comments?, colorIndex?, ticks?, seconds?}. Moving keeps its length.
function vcUpdateMarker(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var marker = vcMarkerWithId(sequence, a.id);
    if (!marker) {
      vcRefuse("There is no marker " + a.id + " on \"" + sequence.name + "\"");
    }
    if (a.name !== undefined && a.name !== null) {
      marker.name = a.name;
    }
    if (a.comments !== undefined && a.comments !== null) {
      marker.comments = a.comments;
    }
    if (a.colorIndex !== undefined && a.colorIndex !== null && typeof marker.setColorByIndex === "function") {
      marker.setColorByIndex(a.colorIndex);
    }
    if (a.ticks !== undefined && a.ticks !== null) {
      if (vcMarkerAtTicks(sequence, a.ticks, marker.guid)) {
        vcRefuse("There is already a marker at " + a.seconds + " s");
      }
      var length = (Number(marker.end.ticks) - Number(marker.start.ticks)) / VC_TICKS_PER_SECOND;
      // Setting a marker's start moves its end with it in 26.5.2; the end is only set again if an
      // older Premiere left the length changed.
      marker.start = a.seconds;
      var now = (Number(marker.end.ticks) - Number(marker.start.ticks)) / VC_TICKS_PER_SECOND;
      if (Math.abs(now - length) > 0.0005) {
        marker.end = a.seconds + length;
      }
    }
    return vcReadMarker(marker);
  }, args);
}

// args: {timeline, ids?: [guid], all?: true}
function vcRemoveMarkers(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var removed = [];
    var missing = [];
    var ids = [];
    if (a.all === true) {
      var all = vcMarkers(sequence);
      for (var i = 0; i < all.length; i++) {
        ids.push(all[i].id);
      }
    } else {
      ids = a.ids;
    }
    for (var j = 0; j < ids.length; j++) {
      var marker = vcMarkerWithId(sequence, ids[j]);
      if (marker) {
        sequence.markers.deleteMarker(marker);
        removed.push(ids[j]);
      } else {
        missing.push(ids[j]);
      }
    }
    return { removed: removed, notFound: missing };
  }, args);
}

// ------------------------------------------------------------------------------ playhead

function vcGetPlayhead(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    if (!vcIsActive(sequence)) {
      vcRefuse("\"" + sequence.name + "\" isn't the sequence open in Premiere, so it has no playhead");
    }
    return { ticks: sequence.getPlayerPosition().ticks };
  }, args);
}

// args: {timeline, ticks}. Opens the sequence first if another one is showing.
function vcSetPlayhead(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    if (!vcIsActive(sequence)) {
      app.project.openSequence(sequence.sequenceID);
    }
    sequence.setPlayerPosition(String(a.ticks));
    return { ticks: sequence.getPlayerPosition().ticks };
  }, args);
}

// ------------------------------------------------------------------------------ direct edits (Phase 4b)
// Copied from VibeCut's host.jsx 0.9.4, with every helper they call.

function vcTime(ticks) {
  var t = new Time();
  t.ticks = String(ticks);
  return t;
}

function vcSequenceIds() {
  var ids = {};
  for (var i = 0; i < app.project.sequences.numSequences; i++) {
    ids[app.project.sequences[i].sequenceID] = true;
  }
  return ids;
}

// The bin called `name` at the top of the project, made if there is none.
function vcBin(name) {
  var root = app.project.rootItem;
  for (var pass = 0; pass < 2; pass++) {
    for (var i = 0; i < root.children.numItems; i++) {
      var child = root.children[i];
      if (child.type === ProjectItemType.BIN && child.name === name) {
        return child;
      }
    }
    if (pass === 0) {
      root.createBin(name);
    }
  }
  vcRefuse("Premiere couldn't make the bin \"" + name + "\"");
}

// Every clip on the sequence by nodeId: {item, type, track (0-based)}.
function vcItems(sequence) {
  var found = {};
  var kinds = [["video", sequence.videoTracks], ["audio", sequence.audioTracks]];
  for (var k = 0; k < kinds.length; k++) {
    var tracks = kinds[k][1];
    for (var t = 0; t < tracks.numTracks; t++) {
      var clips = tracks[t].clips;
      for (var c = 0; c < clips.numItems; c++) {
        found[clips[c].nodeId] = { item: clips[c], type: kinds[k][0], track: t };
      }
    }
  }
  return found;
}

function vcItemWithId(sequence, id) {
  var entry = vcItems(sequence)[id];
  if (!entry) {
    vcRefuse("There is no clip " + id + " on \"" + sequence.name + "\" any more");
  }
  return entry;
}

function vcPlaced(entry, id) {
  var read = vcReadClip(entry.item, entry.type === "audio");
  read.type = entry.type;
  read.track = entry.track;
  read.id = id;
  return read;
}

// args: {timeline, name}. Clones the sequence, names the copy and leaves the open sequence open.
// A copy of `sequence` named `name` (Premiere names it "<name> Copy" and allows names that are taken,
// so the copy is found by its new id and named here). Returns the copy.
function vcCloneSequence(sequence, name, failure) {
  var before = vcSequenceIds();
  if (!sequence.clone()) {
    vcRefuse(failure);
  }
  var copy = null;
  for (var i = 0; i < app.project.sequences.numSequences; i++) {
    if (!before[app.project.sequences[i].sequenceID]) {
      copy = app.project.sequences[i];
    }
  }
  if (!copy) {
    vcRefuse(failure);
  }
  copy.name = name;
  return copy;
}

function vcBackupSequence(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var active = app.project.activeSequence;
    var copy = vcCloneSequence(sequence, a.name, "Premiere didn't copy the sequence, so no edit was made");
    if (active && (!app.project.activeSequence || app.project.activeSequence.sequenceID !== active.sequenceID)) {
      app.project.openSequence(active.sequenceID);
    }
    return { name: copy.name };
  }, args);
}

// The project item of a media file already in the project, or null.
function vcFindMedia(path) {
  var stack = [app.project.rootItem];
  while (stack.length) {
    var folder = stack.pop();
    for (var i = 0; i < folder.children.numItems; i++) {
      var child = folder.children[i];
      if (child.type === ProjectItemType.BIN) {
        stack.push(child);
      } else if (child.type === ProjectItemType.CLIP) {
        try {
          if (child.getMediaPath() === path) {
            return child;
          }
        } catch (e) {
          // Not a file-backed clip.
        }
      }
    }
  }
  return null;
}

// The project item for a media file: one already in the project, else imported into `bin`.
function vcProjectItemFor(path, binName) {
  var found = vcFindMedia(path);
  if (found) {
    return found;
  }
  var bin = vcBin(binName);
  if (!app.project.importFiles([path], true, bin, false)) {
    vcRefuse("Premiere couldn't import " + path);
  }
  for (var j = 0; j < bin.children.numItems; j++) {
    try {
      if (bin.children[j].getMediaPath() === path) {
        return bin.children[j];
      }
    } catch (e2) {
      // Not a file-backed clip.
    }
  }
  vcRefuse("Premiere imported " + path + " but VibeCut couldn't find it in the \"" + binName + "\" bin");
}

// The project item with this nodeId, which must be the clip of that media file.
function vcProjectClip(id, path) {
  var item = vcProjectItemWithId(id).item;
  var mediaPath = null;
  try {
    mediaPath = item.getMediaPath();
  } catch (e) {
    mediaPath = null;
  }
  if (item.type !== ProjectItemType.CLIP || mediaPath !== path) {
    vcRefuse("The project item " + id + " isn't the clip of " + path + " any more");
  }
  return item;
}

// args: {timeline, path, itemId?, inSeconds, outSeconds, atTicks, videoTrack, audioTrack, bin}.
// Overwrites that range of the file (the project item itemId, else one found by its path or imported
// into the bin) onto the 0-based tracks at atTicks (premiere_edit.py has made sure the place is free),
// then gives the project item its own In/Out back. Returns every clip that appeared.
function vcPlaceClip(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var item = a.itemId ? vcProjectClip(a.itemId, a.path) : vcProjectItemFor(a.path, a.bin);
    var before = vcItems(sequence);
    var oldIn = item.getInPoint(4).seconds;
    var oldOut = item.getOutPoint(4).seconds;
    item.setInPoint(a.inSeconds, 4);
    item.setOutPoint(a.outSeconds, 4);
    try {
      sequence.overwriteClip(item, vcTime(a.atTicks), a.videoTrack, a.audioTrack);
    } finally {
      item.setInPoint(oldIn, 4);
      item.setOutPoint(oldOut, 4);
    }
    var after = vcItems(sequence);
    var placed = [];
    for (var id in after) {
      if (after.hasOwnProperty(id) && !before[id]) {
        placed.push(vcPlaced(after[id], id));
      }
    }
    return { placed: placed };
  }, args);
}

// args: {timeline, inTicks, outTicks, ids, name} (PLAN.md, "13f"). Nests the range: a new sequence made
// from it (createSubsequence, every track), named `name`, the clips `ids` lifted and the new sequence
// overwritten into the gap on V1 and A1. Checked live in the 13f probe (Premiere 26.5.2). Returns the
// new sequence's name and the clips that are now there.
function vcNestRange(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    if (!vcIsActive(sequence)) {
      vcRefuse("\"" + sequence.name + "\" isn't the sequence open in Premiere; open it to nest");
    }
    var found = vcItems(sequence);
    for (var i = 0; i < a.ids.length; i++) {
      if (!found[a.ids[i]]) {
        vcRefuse("There is no clip " + a.ids[i] + " on \"" + sequence.name + "\" any more");
      }
    }
    var oldIn = sequence.getInPointAsTime().ticks;
    var oldOut = sequence.getOutPointAsTime().ticks;
    sequence.setInPoint(vcTime(a.inTicks).seconds);
    sequence.setOutPoint(vcTime(a.outTicks).seconds);
    var nested;
    try {
      nested = sequence.createSubsequence(true);
    } finally {
      sequence.setInPoint(vcTime(oldIn).seconds);
      sequence.setOutPoint(vcTime(oldOut).seconds);
    }
    if (!nested) {
      vcRefuse("Premiere didn't make the nested sequence");
    }
    nested.name = a.name;
    var removed = [];
    for (var r = 0; r < a.ids.length; r++) {
      found[a.ids[r]].item.remove(false, true);
      removed.push(a.ids[r]);
    }
    var before = vcItems(sequence);
    sequence.overwriteClip(nested.projectItem, vcTime(a.inTicks), 0, 0);
    var after = vcItems(sequence);
    var placed = [];
    for (var id in after) {
      if (after.hasOwnProperty(id) && !before[id]) {
        placed.push(vcPlaced(after[id], id));
      }
    }
    return { sequence: nested.name, removed: removed, placed: placed };
  }, args);
}

// args: {timeline, ids}. Lifts each clip out, leaving a gap.
function vcRemoveItems(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var found = vcItems(sequence);
    var removed = [];
    var missing = [];
    for (var i = 0; i < a.ids.length; i++) {
      var entry = found[a.ids[i]];
      if (entry) {
        entry.item.remove(false, false);
        removed.push(a.ids[i]);
      } else {
        missing.push(a.ids[i]);
      }
    }
    return { removed: removed, notFound: missing };
  }, args);
}

function vcLevelProperty(clip) {
  for (var c = 0; c < clip.components.numItems; c++) {
    var component = clip.components[c];
    if (component.displayName !== "Volume") {
      continue;
    }
    for (var p = 0; p < component.properties.numItems; p++) {
      if (component.properties[p].displayName === "Level") {
        return component.properties[p];
      }
    }
  }
  return null;
}

// args: {timeline, items: [{id, disabled?, level?, inTicks?, outTicks?, startTicks?, endTicks?}]}.
// Sets what each names, in that order (source points, then the place), and reads it back.
function vcSetItems(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var out = [];
    for (var i = 0; i < a.items.length; i++) {
      var want = a.items[i];
      var entry = vcItemWithId(sequence, want.id);
      var clip = entry.item;
      if (want.disabled !== undefined && want.disabled !== null) {
        clip.disabled = want.disabled === true;
      }
      if (want.level !== undefined && want.level !== null) {
        var level = vcLevelProperty(clip);
        if (!level) {
          vcRefuse("\"" + clip.name + "\" has no Volume effect to set");
        }
        // Premiere switches level animation on for every sound clip, so only real keyframes (more
        // than one) are refused; one level over the whole clip can be set.
        var keys = typeof level.isTimeVarying === "function" && level.isTimeVarying() ? level.getKeys() : null;
        if (keys && keys.length > 1) {
          vcRefuse("\"" + clip.name + "\" has level keyframes; change them in Premiere");
        }
        level.setValue(want.level, true);
      }
      if (want.inTicks !== undefined && want.inTicks !== null) {
        clip.inPoint = vcTime(want.inTicks);
      }
      if (want.outTicks !== undefined && want.outTicks !== null) {
        clip.outPoint = vcTime(want.outTicks);
      }
      if (want.startTicks !== undefined && want.startTicks !== null) {
        clip.start = vcTime(want.startTicks);
      }
      if (want.endTicks !== undefined && want.endTicks !== null) {
        clip.end = vcTime(want.endTicks);
      }
      out.push(vcPlaced(vcItemWithId(sequence, want.id), want.id));
    }
    return { items: out };
  }, args);
}

// args: {timeline, ids, offsetTicks}. Moves each clip along its track by the offset.
function vcMoveItems(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var out = [];
    for (var i = 0; i < a.ids.length; i++) {
      var entry = vcItemWithId(sequence, a.ids[i]);
      entry.item.move(vcTime(a.offsetTicks));
      out.push(vcPlaced(vcItemWithId(sequence, a.ids[i]), a.ids[i]));
    }
    return { items: out };
  }, args);
}

var VC_AUDIO_TRACK_TYPE = 1;

// The QE sequence for this one, opened first if another is showing. Returns {qe, reopen} where
// reopen() shows the sequence that was open before again.
function vcQeSequence(sequence) {
  if (typeof app.enableQE !== "function") {
    vcRefuse("Premiere's QE scripting, which adds and removes tracks, isn't available");
  }
  app.enableQE();
  if (typeof qe === "undefined" || !qe.project) {
    vcRefuse("Premiere's QE scripting, which adds and removes tracks, isn't available");
  }
  var before = app.project.activeSequence;
  if (!vcIsActive(sequence)) {
    app.project.openSequence(sequence.sequenceID);
  }
  if (!vcIsActive(sequence)) {
    vcRefuse("Premiere didn't open \"" + sequence.name + "\", so VibeCut can't change its tracks");
  }
  var reopen = function () {
    if (before && before.sequenceID !== sequence.sequenceID) {
      app.project.openSequence(before.sequenceID);
    }
  };
  return { qe: qe.project.getActiveSequence(), reopen: reopen };
}

// args: {timeline, video, audio}. Adds that many tracks at the end of each kind.
function vcAddTracks(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var v0 = sequence.videoTracks.numTracks;
    var a0 = sequence.audioTracks.numTracks;
    var q = vcQeSequence(sequence);
    try {
      if (a.video > 0) {
        q.qe.addTracks(a.video, v0, 0);
      }
      if (a.audio > 0) {
        q.qe.addTracks(0, 0, a.audio, VC_AUDIO_TRACK_TYPE, a0);
      }
    } finally {
      q.reopen();
    }
    var now = vcSequenceNamed(a.timeline);
    return { videoBefore: v0, audioBefore: a0, video: now.videoTracks.numTracks, audio: now.audioTracks.numTracks };
  }, args);
}

// args: {timeline, video: [0-based], audio: [0-based]}. Removes each track only while it's the last of
// its kind and empty, highest first; the rest are kept.
function vcRemoveTracks(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var q = vcQeSequence(sequence);
    var removed = { video: [], audio: [] };
    var kept = { video: [], audio: [] };
    try {
      var kinds = [["video", "videoTracks", "removeVideoTrack"], ["audio", "audioTracks", "removeAudioTrack"]];
      for (var k = 0; k < kinds.length; k++) {
        var wanted = (a[kinds[k][0]] || []).slice().sort(function (x, y) {
          return y - x;
        });
        for (var i = 0; i < wanted.length; i++) {
          var tracks = vcSequenceNamed(a.timeline)[kinds[k][1]];
          var track = wanted[i] < tracks.numTracks ? tracks[wanted[i]] : null;
          var empty = track && track.clips.numItems === 0 && (!track.transitions || track.transitions.numItems === 0);
          if (!empty || wanted[i] !== tracks.numTracks - 1) {
            kept[kinds[k][0]].push(wanted[i]);
            continue;
          }
          q.qe[kinds[k][2]](wanted[i]);
          if (vcSequenceNamed(a.timeline)[kinds[k][1]].numTracks === tracks.numTracks - 1) {
            removed[kinds[k][0]].push(wanted[i]);
          } else {
            kept[kinds[k][0]].push(wanted[i]);
          }
        }
      }
    } finally {
      q.reopen();
    }
    return { removed: removed, kept: kept };
  }, args);
}

// Every bin and item, depth-first in the panel's own order; a bin's items come before its bins.
function vcWalkProject(visit) {
  var root = app.project.rootItem;
  var rootName = vcProjectName(app.project);
  var bins = [{ id: root.nodeId, path: rootName, item: root }];
  var go = function (folder, path) {
    var subs = [];
    for (var i = 0; i < folder.children.numItems; i++) {
      var child = folder.children[i];
      if (child.type === ProjectItemType.BIN) {
        subs.push(child);
      } else {
        visit(child, path);
      }
    }
    for (var j = 0; j < subs.length; j++) {
      var subPath = path + "/" + subs[j].name;
      bins.push({ id: subs[j].nodeId, path: subPath, item: subs[j] });
      go(subs[j], subPath);
    }
  };
  go(root, rootName);
  return bins;
}

// Every project item and bin by nodeId: {item, bin (the path of the bin it's in; null for the root)}.
function vcProjectIndex() {
  var index = {};
  var bins = vcWalkProject(function (item, path) {
    index[item.nodeId] = { item: item, bin: path };
  });
  for (var b = 0; b < bins.length; b++) {
    var at = bins[b].path.lastIndexOf("/");
    index[bins[b].id] = { item: bins[b].item, bin: at < 0 ? null : bins[b].path.substr(0, at) };
  }
  return index;
}

function vcProjectItemWithId(id, index) {
  var found = (index || vcProjectIndex())[id];
  if (!found) {
    vcRefuse("There is no project item " + id + " any more");
  }
  return found;
}

// args: {timeline, ids}. Links the clips (a clip put back by Revert and the partners that stayed), so
// they move together again. Premiere links what's selected, so the selection is set, linked and cleared.
// Checked in 26.5.2: linkSelection() returns false for a selection that includes an already linked pair.
// Linking goes through the selection, so the user's selection is kept and put back afterwards
// (checked in the 8a.0 probe: the saved clips select again exactly).
function vcClearSelection(sequence) {
  var selected = sequence.getSelection();
  for (var s = 0; s < selected.length; s++) {
    selected[s].setSelected(false, true);
  }
}

function vcSaveSelection(sequence) {
  var selected = sequence.getSelection();
  var saved = [];
  for (var s = 0; s < selected.length; s++) {
    saved.push(selected[s]);
  }
  vcClearSelection(sequence);
  return saved;
}

function vcRestoreSelection(sequence, saved) {
  vcClearSelection(sequence);
  for (var s = 0; s < saved.length; s++) {
    try {
      saved[s].setSelected(true, true);
    } catch (e) {
      // A clip the edit removed.
    }
  }
}

// Selects the clips with these ids; returns how many were found.
function vcSelectIds(sequence, ids) {
  var found = vcItems(sequence);
  var chosen = 0;
  for (var i = 0; i < ids.length; i++) {
    if (found[ids[i]]) {
      found[ids[i]].item.setSelected(true, true);
      chosen++;
    }
  }
  return chosen;
}

function vcLinkItems(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var saved = vcSaveSelection(sequence);
    var ok = false;
    try {
      var chosen = vcSelectIds(sequence, a.ids);
      // Premiere won't link a selection that already holds a linked pair, so it's unlinked first and
      // then linked as one group.
      if (chosen > 1 && typeof sequence.unlinkSelection === "function") {
        sequence.unlinkSelection();
      }
      ok = chosen > 1 ? sequence.linkSelection() : false;
    } finally {
      vcRestoreSelection(sequence, saved);
    }
    var check = vcItems(sequence)[a.ids[0]];
    return { linked: check ? vcLinkedIds(check.item).length : 0, answer: ok === true || ok === 1 };
  }, args);
}

// The property a fade animates: Opacity for picture, Level for sound.
function vcFadeProperty(clip, isAudio) {
  if (isAudio) {
    return vcLevelProperty(clip);
  }
  for (var c = 0; c < clip.components.numItems; c++) {
    var component = clip.components[c];
    if (component.matchName === "AE.ADBE Opacity") {
      for (var p = 0; p < component.properties.numItems; p++) {
        if (component.properties[p].displayName === "Opacity") {
          return component.properties[p];
        }
      }
    }
  }
  return null;
}

function vcReadFade(entry, id) {
  var prop = vcFadeProperty(entry.item, entry.type === "audio");
  if (!prop) {
    vcRefuse("\"" + entry.item.name + "\" has no " + (entry.type === "audio" ? "Volume" : "Opacity") + " to fade");
  }
  var keys = [];
  var animated = typeof prop.isTimeVarying === "function" && prop.isTimeVarying();
  if (animated) {
    var times = prop.getKeys() || [];
    for (var k = 0; k < times.length; k++) {
      keys.push({ ticks: times[k].ticks, value: prop.getValueAtKey(times[k]) });
    }
  }
  return { id: id, value: animated && keys.length ? null : prop.getValue(), keys: keys };
}

// args: {timeline, ids}. Each clip's fade property: its keys ({ticks (source), value}) and, when it has
// none, its value.
function vcReadFades(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var out = [];
    for (var i = 0; i < a.ids.length; i++) {
      out.push(vcReadFade(vcItemWithId(sequence, a.ids[i]), a.ids[i]));
    }
    return { items: out };
  }, args);
}

// args: {timeline, items: [{id, keys: [{ticks, value}], value}]}. Replaces each clip's fade keys: all
// are cleared, then `keys` are set; with none, the property is left at `value`.
function vcSetFades(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var out = [];
    for (var i = 0; i < a.items.length; i++) {
      var want = a.items[i];
      var entry = vcItemWithId(sequence, want.id);
      var prop = vcFadeProperty(entry.item, entry.type === "audio");
      if (!prop) {
        vcRefuse("\"" + entry.item.name + "\" has no " + (entry.type === "audio" ? "Volume" : "Opacity") + " to fade");
      }
      prop.setTimeVarying(false);
      if (want.keys.length) {
        prop.setTimeVarying(true);
        for (var k = 0; k < want.keys.length; k++) {
          var at = vcTime(want.keys[k].ticks);
          prop.addKey(at);
          prop.setValueAtKey(at, want.keys[k].value, true);
        }
      } else {
        prop.setValue(want.value, true);
      }
      out.push(vcReadFade(vcItemWithId(sequence, want.id), want.id));
    }
    return { items: out };
  }, args);
}

// args: {timeline, ids, timecode}. Razors the track of each clip at the timecode (the sequence's own
// frames, "HH:MM:SS:FF"); premiere_timing.py reads the sequence before and after to find the new pieces.
function vcRazor(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var found = vcItems(sequence);
    var tracks = {};
    for (var i = 0; i < a.ids.length; i++) {
      var entry = found[a.ids[i]];
      if (!entry) {
        vcRefuse("There is no clip " + a.ids[i] + " on \"" + sequence.name + "\" any more");
      }
      tracks[entry.type + ":" + entry.track] = entry;
    }
    var q = vcQeSequence(sequence);
    var cut = 0;
    try {
      for (var key in tracks) {
        if (tracks.hasOwnProperty(key)) {
          var e = tracks[key];
          var track = e.type === "audio" ? q.qe.getAudioTrackAt(e.track) : q.qe.getVideoTrackAt(e.track);
          track.razor(a.timecode);
          cut++;
        }
      }
    } finally {
      q.reopen();
    }
    return { tracks: cut };
  }, args);
}

// args: {paths, bin} (PLAN.md, "Phase 5"). Each file already in the project is reused; the others are
// imported into the top-level bin `bin` (made if missing). Returns {items: [{path, id, imported}]}.
function vcImportMedia(args) {
  return vcAnswer(function (a) {
    var items = [];
    for (var i = 0; i < a.paths.length; i++) {
      var existing = vcFindMedia(a.paths[i]);
      var item = existing || vcProjectItemFor(a.paths[i], a.bin);
      items.push({ path: a.paths[i], id: item.nodeId, imported: !existing });
    }
    return { items: items };
  }, args);
}

// From VibeCut's host.jsx (Phase 10b): seconds as a Source monitor timecode at `fps`.
function vcSourceTimecode(seconds, fps) {
  var nominal = Math.round(fps);
  var frames = Math.round(seconds * fps);
  var ff = frames % nominal;
  var total = Math.floor(frames / nominal);
  var two = function (n) {
    return (n < 10 ? "0" : "") + n;
  };
  return two(Math.floor(total / 3600)) + ":" + two(Math.floor(total / 60) % 60) + ":" + two(total % 60) + ":" + two(ff);
}

// From VibeCut's host.jsx (Phase 10b). args: {path, inSeconds, outSeconds}. Opens the file in the Source
// monitor without importing it, marks In/Out and puts the playhead at In. Returns {marked, atIn}.
function vcSourcePreview(args) {
  return vcAnswer(function (a) {
    if (!app.sourceMonitor.openFilePath(a.path)) {
      vcRefuse("Premiere couldn't open " + a.path + " in the Source monitor");
    }
    var shown = app.sourceMonitor.getProjectItem();
    var marked = false;
    var fps = 25;
    if (shown) {
      try {
        shown.setInPoint(a.inSeconds, 4);
        shown.setOutPoint(a.outSeconds, 4);
        marked = true;
      } catch (e) {}
      try {
        var rate = shown.getFootageInterpretation().frameRate;
        if (rate > 0) fps = rate;
      } catch (e2) {}
    }
    var atIn = false;
    try {
      app.enableQE();
      qe.source.player.scrubTo(vcSourceTimecode(a.inSeconds, fps));
      atIn = Math.abs(app.sourceMonitor.getPosition().seconds - a.inSeconds) <= 1.5 / fps;
    } catch (e3) {}
    return { marked: marked, atIn: atIn };
  }, args);
}

// ---------------------------------------------------------------- Phase 6a: the project (PLAN.md)
// From VibeCut's host.jsx verbatim (its "Phase 8c" and "Connect page" 4d): sequences, selection and
// reading the Project panel.

// args: {name, preset}. An empty sequence, opened.
function vcCreateSequence(args) {
  return vcAnswer(function (a) {
    if (typeof app.enableQE !== "function") {
      vcRefuse("Premiere's QE scripting, which makes an empty sequence, isn't available");
    }
    app.enableQE();
    var before = vcSequenceIds();
    qe.project.newSequence(a.name, a.preset);
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      var made = app.project.sequences[i];
      if (!before[made.sequenceID]) {
        app.project.openSequence(made.sequenceID);
        return { name: made.name, timebase: String(made.timebase) };
      }
    }
    vcRefuse("Premiere didn't make the sequence");
  }, args);
}

// args: {timeline, name}. A copy, opened.
function vcDuplicateSequence(args) {
  return vcAnswer(function (a) {
    var copy = vcCloneSequence(vcSequenceNamed(a.timeline), a.name, "Premiere didn't copy the sequence");
    app.project.openSequence(copy.sequenceID);
    return { name: copy.name };
  }, args);
}

// args: {timeline}.
function vcOpenSequence(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    app.project.openSequence(sequence.sequenceID);
    return { name: sequence.name, isActive: vcIsActive(sequence) };
  }, args);
}

// args: {timeline, name}.
function vcRenameSequence(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    sequence.name = a.name;
    return { name: sequence.name };
  }, args);
}

// args: {timeline, ids, additive}. Selects the clips in the sequence (trackItem.setSelected).
function vcSelectItems(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    if (!a.additive) {
      vcClearSelection(sequence);
    }
    vcSelectIds(sequence, a.ids);
    var now = sequence.getSelection();
    var ids = [];
    for (var n = 0; n < now.length; n++) {
      ids.push(now[n].nodeId);
    }
    return { selected: ids };
  }, args);
}

// args: {ids}. Selects project items in the Project panel (projectItem.select(), which replaces the
// selection: 8c.0 probe) and reads back what's selected.
function vcSelectProjectItems(args) {
  return vcAnswer(function (a) {
    var index = vcProjectIndex();
    for (var i = 0; i < a.ids.length; i++) {
      vcProjectItemWithId(a.ids[i], index).item.select();
    }
    var now = app.getCurrentProjectViewSelection();
    var ids = [];
    for (var n = 0; now && n < now.length; n++) {
      ids.push(now[n].nodeId);
    }
    return { selected: ids };
  }, args);
}

var VC_MAX_PROJECT_ITEMS = 2000;

// The Project panel columns read for each item, by their ids in getProjectColumnsMetadata().
var VC_COLUMNS = {
  "Column.PropertyText.Label": "Label",
  "Column.Intrinsic.MediaTimebase": "MediaTimebase",
  "Column.Intrinsic.MediaDuration": "MediaDuration",
  "Column.Intrinsic.VideoInfo": "VideoInfo",
  "Column.Intrinsic.AudioInfo": "AudioInfo",
  "Column.PropertyText.Status": "Status",
  "Column.PropertyText.Description": "Description",
  "Column.Intrinsic.LogNote": "LogNote",
  "Column.PropertyText.Scene": "Scene",
  "Column.PropertyText.Shot": "Shot",
  "Column.PropertyBool.Good": "Good"
};

// getProjectColumnsMetadata() is a JSON array written by Premiere itself; ES3 has no JSON.parse.
function vcColumnsOf(item, all) {
  var out = {};
  var raw = String(item.getProjectColumnsMetadata() || "");
  if (raw.charAt(0) !== "[") {
    return out;
  }
  var columns = eval("(" + raw + ")");
  for (var i = 0; i < columns.length; i++) {
    var column = columns[i];
    var value = column.ColumnValue === undefined || column.ColumnValue === null ? "" : String(column.ColumnValue);
    if (value === "") {
      continue;
    }
    if (VC_COLUMNS.hasOwnProperty(column.ColumnID)) {
      out[VC_COLUMNS[column.ColumnID]] = value;
    } else if (all) {
      out[String(column.ColumnName)] = value;
    }
  }
  return out;
}

function vcIsSequenceItem(item) {
  try {
    return item.isSequence() === true;
  } catch (e) {
    return false;
  }
}

function vcReadProjectItem(item, binPath, all) {
  var read = { id: item.nodeId, name: item.name, bin: binPath, sequence: vcIsSequenceItem(item), label: null, mediaPath: null, offline: false };
  try {
    read.label = item.getColorLabel();
  } catch (e1) {
    read.label = null;
  }
  if (read.sequence) {
    return read;
  }
  try {
    read.mediaPath = item.getMediaPath() || null;
  } catch (e2) {
    read.mediaPath = null;
  }
  try {
    read.offline = item.isOffline() === true;
  } catch (e3) {
    read.offline = false;
  }
  try {
    read.inSeconds = item.getInPoint(4).seconds;
    read.outSeconds = item.getOutPoint(4).seconds;
  } catch (e4) {
    // Not every item has In/Out (a title, for one).
  }
  read.columns = vcColumnsOf(item, all);
  return read;
}

// Times each project item is used on any sequence: one per clip on a video track, or per clip on
// an audio track for items with no picture, at one place on one sequence.
function vcUsage() {
  var seen = {};
  for (var s = 0; s < app.project.sequences.numSequences; s++) {
    var sequence = app.project.sequences[s];
    var kinds = [sequence.videoTracks, sequence.audioTracks];
    for (var k = 0; k < kinds.length; k++) {
      for (var t = 0; t < kinds[k].numTracks; t++) {
        var clips = kinds[k][t].clips;
        for (var c = 0; c < clips.numItems; c++) {
          var item = clips[c].projectItem;
          if (!item) {
            continue;
          }
          var key = sequence.sequenceID + ":" + clips[c].start.ticks;
          if (!seen[item.nodeId]) {
            seen[item.nodeId] = {};
          }
          seen[item.nodeId][key] = true;
        }
      }
    }
  }
  var usage = {};
  for (var id in seen) {
    if (seen.hasOwnProperty(id)) {
      var n = 0;
      for (var place in seen[id]) {
        if (seen[id].hasOwnProperty(place)) {
          n++;
        }
      }
      usage[id] = n;
    }
  }
  return usage;
}

// What's selected in the Project panel, and on the connected sequence with the clip under its
// playhead (the topmost video clip there) when it's the one open.
function vcProjectSelection(timeline) {
  var selection = { project: [], timeline: [], underPlayhead: null };
  try {
    var chosen = app.getCurrentProjectViewSelection();
    if (chosen) {
      for (var i = 0; i < chosen.length; i++) {
        selection.project.push(chosen[i].nodeId);
      }
    }
  } catch (e) {
    // No Project panel open.
  }
  var active = app.project.activeSequence;
  if (!active || typeof timeline !== "string" || active.name !== timeline) {
    return selection;
  }
  var picked = active.getSelection();
  for (var p = 0; p < picked.length; p++) {
    selection.timeline.push(picked[p].nodeId);
  }
  var at = Number(active.getPlayerPosition().ticks);
  for (var v = active.videoTracks.numTracks - 1; v >= 0 && selection.underPlayhead === null; v--) {
    var clips = active.videoTracks[v].clips;
    for (var c = 0; c < clips.numItems; c++) {
      if (Number(clips[c].start.ticks) <= at && at < Number(clips[c].end.ticks)) {
        selection.underPlayhead = clips[c].nodeId;
        break;
      }
    }
  }
  return selection;
}

// args: {timeline?, usage?}. Every bin, item (up to VC_MAX_PROJECT_ITEMS), how often each is used
// (unless usage is false: organising doesn't need it) and the selections.
function vcReadProject(args) {
  return vcAnswer(function (a) {
    vcProject();
    var items = [];
    var truncated = false;
    var counts = {};
    var bins = vcWalkProject(function (item, path) {
      counts[path] = (counts[path] || 0) + 1;
      if (items.length >= VC_MAX_PROJECT_ITEMS && !vcIsSequenceItem(item)) {
        truncated = true;
        return;
      }
      items.push(vcReadProjectItem(item, path, false));
    });
    var outBins = [];
    for (var b = 0; b < bins.length; b++) {
      outBins.push({ id: bins[b].id, path: bins[b].path, items: counts[bins[b].path] || 0 });
    }
    return { root: vcProjectName(app.project), bins: outBins, items: items, truncated: truncated, usage: a.usage === false ? {} : vcUsage(), selection: vcProjectSelection(a.timeline) };
  }, args);
}

// args: {id}. One item in full: every Project panel column that's set, its usage and its own markers.
function vcProjectItemInfo(args) {
  return vcAnswer(function (a) {
    vcProject();
    var found = vcProjectItemWithId(a.id);
    var read = vcReadProjectItem(found.item, found.bin, true);
    read.usage = vcUsage()[a.id] || 0;
    read.markers = [];
    var markers = null;
    try {
      markers = found.item.getMarkers();
    } catch (e) {
      markers = null;
    }
    if (markers) {
      var marker = markers.getFirstMarker();
      while (marker) {
        read.markers.push(vcReadMarker(marker));
        marker = markers.getNextMarker(marker);
      }
    }
    return read;
  }, args);
}

// ---------------------------------------------------------------- Phase 6b: a draft as a new sequence
// From VibeCut's host.jsx verbatim (its "Connect page, phase 4b").

// args: {path, name, bin}. Imports VibeCut's rebuilt Premiere XML into the bin, names the sequence it
// made and opens it. bridge.js has checked that the file is in VibeCut's imports folder.
function vcImportSequence(args) {
  return vcAnswer(function (a) {
    vcProject();
    var before = vcSequenceIds();
    var bin = vcBin(a.bin);
    if (!app.project.importFiles([a.path], true, bin, false)) {
      vcRefuse("Premiere couldn't import the rebuilt sequence. The connected sequence is unchanged");
    }
    var made = [];
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      if (!before[app.project.sequences[i].sequenceID]) {
        made.push(app.project.sequences[i]);
      }
    }
    if (made.length === 0) {
      vcRefuse("Premiere imported the rebuilt sequence's file but made no sequence from it. The connected sequence is unchanged");
    }
    var sequence = made[0];
    sequence.name = a.name;
    app.project.openSequence(sequence.sequenceID);
    return { name: sequence.name, sequences: made.length };
  }, args);
}

// ---------------------------------------------------------------- Phase 6c: linking clips
// From VibeCut's host.jsx verbatim (its "Phase 8a").

// args: {timeline, unlink: [ids], groups: [[ids]]}. Premiere links and unlinks only whole selections
// (8a.0 probe: one member of a group selected doesn't unlink), so every clip of `unlink` is unlinked
// together and then each group is linked on its own. host-premiere reads the result back.
function vcSetLinks(args) {
  return vcAnswer(function (a) {
    var sequence = vcSequenceNamed(a.timeline);
    var saved = vcSaveSelection(sequence);
    var linked = 0;
    try {
      if (vcSelectIds(sequence, a.unlink) > 1 && typeof sequence.unlinkSelection === "function") {
        sequence.unlinkSelection();
      }
      vcClearSelection(sequence);
      for (var g = 0; g < a.groups.length; g++) {
        if (vcSelectIds(sequence, a.groups[g]) > 1) {
          var ok = sequence.linkSelection();
          if (ok === true || ok === 1) {
            linked++;
          }
        }
        vcClearSelection(sequence);
      }
    } finally {
      vcRestoreSelection(sequence, saved);
    }
    return { groups: linked };
  }, args);
}
