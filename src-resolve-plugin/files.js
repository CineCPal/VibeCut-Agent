"use strict";

/**
 * The only file access VibeCut Agent's window in DaVinci Resolve has (PLAN.md, "In-host panels"; ported
 * from VibeCut's plugin, removed in its commit 9e056a4). The sandboxed panel asks the main process for
 * these through IPC; every path must stay inside VibeCut Agent's chat folder for Resolve,
 * `VibeCut Agent/host-bridge/chat/resolve/`, without passing through a symlink. Never VibeCut's folder.
 * Plain Node, no Electron, so Vitest can test it.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/** `state.json` and `broll.json` may be up to 4 MiB (host_chat.rs `MAX_FILE_BYTES`). */
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** An inbox action is at most 64 KiB (host_chat.rs refuses bigger ones). */
const MAX_WRITE_BYTES = 64 * 1024;
/** What a shot dragged out of the B-roll tab may be. */
const MEDIA_EXTENSIONS = new Set([".mov", ".mp4", ".m4v", ".mxf", ".avi", ".mkv", ".mts", ".m2ts", ".braw", ".r3d", ".dng", ".wav", ".aif", ".aiff", ".mp3", ".m4a"]);

function chatDir(home) {
  return path.join(home || os.homedir(), "Library", "Application Support", "VibeCut Agent", "host-bridge", "chat", "resolve");
}

function createFileOps(root) {
  const base = path.resolve(root);

  /** The path, resolved, if it is the chat folder or inside it and no part of it is a symlink. */
  function inside(p) {
    if (typeof p !== "string" || !p || p.includes("\0")) throw new Error("Not a path");
    const full = path.resolve(p);
    const rel = path.relative(base, full);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`Outside VibeCut Agent's chat folder: ${p}`);
    }
    let at = base;
    for (const part of ["", ...(rel ? rel.split(path.sep) : [])]) {
      at = part ? path.join(at, part) : at;
      let stat;
      try {
        stat = fs.lstatSync(at);
      } catch (error) {
        if (error.code === "ENOENT") break;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error(`A symlink in VibeCut Agent's chat folder isn't followed: ${at}`);
    }
    return full;
  }

  return {
    async readText(p) {
      const full = inside(p);
      let stat;
      try {
        stat = await fs.promises.lstat(full);
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
      if (!stat.isFile()) return null;
      if (stat.size > MAX_READ_BYTES) throw new Error(`${path.basename(full)} is too big to read`);
      return fs.promises.readFile(full, "utf8");
    },
    async writeText(p, text) {
      const full = inside(p);
      if (typeof text !== "string") throw new Error("Only text is written");
      if (Buffer.byteLength(text, "utf8") > MAX_WRITE_BYTES) throw new Error(`${path.basename(full)} is too big to write`);
      await fs.promises.writeFile(full, text, "utf8");
    },
    async rename(from, to) {
      await fs.promises.rename(inside(from), inside(to));
    },
    async makeDir(p) {
      await fs.promises.mkdir(inside(p), { recursive: true });
    },
  };
}

/**
 * What the panel's page may do: read anything in the chat folder, but write only its inbox actions and
 * its heartbeat. So the files VibeCut Agent writes (state.json, broll.json and the rest) can't be changed
 * from the page, and a drag can trust broll.json. The window's place (window.json) is the main process's.
 */
function createPanelOps(root) {
  const ops = createFileOps(root);
  const base = path.resolve(root);
  const writable = (p) => {
    const rel = typeof p === "string" ? path.relative(base, path.resolve(p)) : "";
    if (rel === "panel-alive.json" || /^inbox\/\.?[A-Za-z0-9_-]{1,64}\.json(\.tmp)?$/.test(rel.split(path.sep).join("/"))) return p;
    throw new Error(`The panel can't write ${p}`);
  };
  return {
    readText: async (p) => ops.readText(p),
    writeText: async (p, text) => ops.writeText(writable(p), text),
    rename: async (from, to) => ops.rename(writable(from), writable(to)),
    makeDir: async (p) => {
      const rel = path.relative(base, path.resolve(p));
      if (rel !== "" && rel !== "inbox") throw new Error(`The panel can't make ${p}`);
      return ops.makeDir(p);
    },
  };
}

/**
 * The file to drag for a B-roll tab shot: its path as VibeCut Agent wrote it in
 * `broll.json`, only if that is an absolute path to a plain media file (no symlink), with the shot's
 * picture (a `data:` URL) for the drag icon when it has one. Null for anything else.
 */
function dragTarget(root, key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) return null;
  const base = path.resolve(root);
  try {
    const listing = path.join(base, "broll.json");
    const stat = fs.lstatSync(listing);
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return null;
    const file = JSON.parse(fs.readFileSync(listing, "utf8"));
    const target = file && file.paths && Object.prototype.hasOwnProperty.call(file.paths, key) ? file.paths[key] : null;
    if (typeof target !== "string" || !path.isAbsolute(target) || target.includes("\0")) return null;
    if (!MEDIA_EXTENSIONS.has(path.extname(target).toLowerCase())) return null;
    const media = fs.lstatSync(target);
    if (!media.isFile()) return null;
    const shot = [...(file.shots || []), ...(file.pool || [])].find((s) => s && s.key === key);
    let icon = null;
    if (shot && typeof shot.thumb === "string" && /^s\d{1,18}\.txt$/.test(shot.thumb)) {
      try {
        const text = fs.readFileSync(path.join(base, "thumbs", shot.thumb), "utf8");
        if (text.startsWith("data:image/")) icon = text;
      } catch {
        // Dragged with the plain icon.
      }
    }
    return { file: target, icon };
  } catch {
    return null;
  }
}

module.exports = { chatDir, createFileOps, createPanelOps, dragTarget, MAX_READ_BYTES, MAX_WRITE_BYTES, MEDIA_EXTENSIONS };
