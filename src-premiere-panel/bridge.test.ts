// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const SOURCE = fs.readFileSync(path.join(__dirname, "bridge.js"), "utf8");
const nodeRequire = createRequire(import.meta.url);

interface Panel {
  dir: string;
  scripts: string[];
  context: vm.Context & { poll: () => Promise<void>; heartbeat: () => void };
}

/** Loads bridge.js as CEP would, with a fake `window.__adobe_cep__` whose evalScript answers `answer`. */
function loadPanel(dir: string, answer: (script: string) => string): Panel {
  const scripts: string[] = [];
  const context = vm.createContext({
    require: nodeRequire,
    process: { env: { VIBECUT_AGENT_PREMIERE_BRIDGE_DIR: dir } },
    console,
    // The panel's own intervals are kept from running; tests drive poll() and heartbeat() directly.
    setInterval: () => 0,
    window: {
      __adobe_cep__: {
        getSystemPath: () => "file:///Library/Extensions/com.vibecutagent.connect",
        getHostEnvironment: () => JSON.stringify({ appVersion: "26.5.2" }),
        evalScript: (script: string, done: (result: string) => void) => {
          scripts.push(script);
          done(answer(script));
        },
      },
    },
  }) as Panel["context"];
  vm.runInContext(SOURCE, context);
  return { dir, scripts, context };
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
/** Writes a request the way the sidecar does: to jobs/<id>.json. */
const writeJob = (dir: string, request: { id: string }) =>
  fs.writeFileSync(path.join(dir, "jobs", `${request.id}.json`), JSON.stringify(request));

describe("Premiere panel bridge.js", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-panel-"));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes a heartbeat with its version and a per-load instance id", () => {
    loadPanel(dir, () => "");
    const first = readJson(path.join(dir, "alive.json"));
    expect(first).toMatchObject({ busy: false, panelVersion: "0.8.0", premiereVersion: "26.5.2" });
    expect(first.instance).toMatch(/^[0-9a-f]{16}$/);

    const other = fs.mkdtempSync(path.join(os.tmpdir(), "vca-panel-"));
    loadPanel(other, () => "");
    expect(readJson(path.join(other, "alive.json")).instance).not.toBe(first.instance);
    fs.rmSync(other, { recursive: true, force: true });
  });

  it("runs an allowed command through host.jsx and writes the reply", async () => {
    const panel = loadPanel(dir, () => JSON.stringify({ ok: true, result: { project: "Promo" } }));
    writeJob(dir, { id: "s1-1", command: "read_sequence", args: { timeline: "Cut  v2" } });
    await panel.context.poll();

    expect(readJson(path.join(dir, "replies", "s1-1.json"))).toEqual({ id: "s1-1", ok: true, result: { project: "Promo" } });
    expect(panel.scripts[0]).toContain("$.evalFile(");
    expect(panel.scripts[0]).toContain('vcReadSequence({"timeline":"Cut \\u2028v2"})');
    expect(fs.readdirSync(path.join(dir, "jobs"))).toEqual([]);
  });

  it("refuses commands outside the allow-list without calling Premiere", async () => {
    const panel = loadPanel(dir, () => "{}");
    writeJob(dir, { id: "s1-2", command: "import_files", args: {} });
    await panel.context.poll();
    expect(readJson(path.join(dir, "replies", "s1-2.json"))).toEqual({ id: "s1-2", ok: false, error: "Unknown command: import_files" });
    expect(panel.scripts).toEqual([]);
  });

  it("checks arguments before calling Premiere", async () => {
    const panel = loadPanel(dir, () => "{}");
    writeJob(dir, { id: "a", command: "read_sequence", args: { timeline: "two\nlines" } });
    writeJob(dir, { id: "b", command: "status", args: { "bad key": 1 } });
    await panel.context.poll();
    expect(readJson(path.join(dir, "replies", "a.json")).error).toBe("timeline must name a sequence in one short line");
    expect(readJson(path.join(dir, "replies", "b.json")).error).toBe("args has an unexpected key");
    expect(panel.scripts).toEqual([]);
  });

  it("reports Premiere's own errors and non-JSON answers", async () => {
    const answers = [JSON.stringify({ ok: false, error: "No project is open in Premiere Pro" }), "EvalScript error."];
    const panel = loadPanel(dir, () => answers.shift() ?? "");
    writeJob(dir, { id: "e1", command: "status" });
    await panel.context.poll();
    writeJob(dir, { id: "e2", command: "status" });
    await panel.context.poll();
    expect(readJson(path.join(dir, "replies", "e1.json")).error).toBe("No project is open in Premiere Pro");
    expect(readJson(path.join(dir, "replies", "e2.json")).error).toBe("Premiere returned something that isn't JSON: EvalScript error.");
  });

  it("checks the direct edits' arguments before calling Premiere", async () => {
    const panel = loadPanel(dir, () => "{}");
    const cases: [string, Record<string, unknown>, string][] = [
      ["p1", { command: "place_clip", args: { timeline: "Main", path: "/no/such/file.mov", bin: "VibeCut" } }, "path must be an existing media file"],
      ["p2", { command: "razor", args: { timeline: "Main", ids: ["n1"], timecode: "1:2" } }, "timecode must be HH:MM:SS:FF"],
      ["p3", { command: "set_fades", args: { timeline: "Main", items: [] } }, "items must list 1 to 200 clips"],
      ["p4", { command: "nest_range", args: { timeline: "Main", ids: ["n1"], name: "a/b", inTicks: "0", outTicks: "1" } }, 'name must be one line of at most 255 characters, without "/"'],
      ["p5", { command: "add_tracks", args: { timeline: "Main", video: 9, audio: 0 } }, "video must be 0 to 8 tracks"],
    ];
    for (const [id, request] of cases) writeJob(dir, { id, ...request });
    await panel.context.poll();
    for (const [id, , error] of cases) expect(readJson(path.join(dir, "replies", `${id}.json`)).error).toBe(error);
    expect(panel.scripts).toEqual([]);
  });

  it("runs an allowed edit through its host.jsx function", async () => {
    const panel = loadPanel(dir, () => JSON.stringify({ ok: true, result: { name: "Main (before VibeCut 1)" } }));
    writeJob(dir, { id: "b1", command: "backup_sequence", args: { timeline: "Main", name: "Main (before VibeCut 1)" } });
    await panel.context.poll();
    expect(readJson(path.join(dir, "replies", "b1.json")).result).toEqual({ name: "Main (before VibeCut 1)" });
    expect(panel.scripts[0]).toContain('vcBackupSequence({"timeline":"Main","name":"Main (before VibeCut 1)"})');
  });

  it("checks the B-roll Library's import and preview before calling Premiere", async () => {
    const clip = path.join(dir, "shot.mov");
    fs.writeFileSync(clip, "x");
    const panel = loadPanel(dir, () => "{}");
    const cases: [string, Record<string, unknown>, string][] = [
      ["i1", { command: "import_media", args: { paths: [], bin: "VibeCut B-roll" } }, "paths must list 1 to 50 files"],
      ["i2", { command: "import_media", args: { paths: ["/no/such.mov"], bin: "VibeCut B-roll" } }, "paths[0] must be an existing media file"],
      ["i3", { command: "import_media", args: { paths: [clip], bin: "a/b" } }, 'bin must be one line of at most 255 characters, without "/"'],
      ["s1", { command: "source_preview", args: { path: "relative.mov", inSeconds: 0, outSeconds: 1 } }, "path must be an existing media file"],
      ["s2", { command: "source_preview", args: { path: clip, inSeconds: 3, outSeconds: 2 } }, "inSeconds and outSeconds must be a range"],
    ];
    for (const [id, request] of cases) writeJob(dir, { id, ...request });
    await panel.context.poll();
    for (const [id, , error] of cases) expect(readJson(path.join(dir, "replies", `${id}.json`)).error).toBe(error);
    expect(panel.scripts).toEqual([]);
  });

  it("runs import and preview through their host.jsx functions", async () => {
    const clip = path.join(dir, "shot.mov");
    fs.writeFileSync(clip, "x");
    const panel = loadPanel(dir, () => JSON.stringify({ ok: true, result: {} }));
    writeJob(dir, { id: "m1", command: "import_media", args: { paths: [clip], bin: "VibeCut B-roll" } });
    await panel.context.poll();
    writeJob(dir, { id: "m2", command: "source_preview", args: { path: clip, inSeconds: 1, outSeconds: 4 } });
    await panel.context.poll();
    expect(panel.scripts[0]).toContain("vcImportMedia(");
    expect(panel.scripts[1]).toContain("vcSourcePreview(");
  });

  it("checks the project commands before calling Premiere (Phase 6a)", async () => {
    const panel = loadPanel(dir, () => "{}");
    const cases: [string, Record<string, unknown>, string][] = [
      ["q1", { command: "create_sequence", args: { name: "Cut", preset: "/tmp/evil.sqpreset" } }, "preset must be one of Premiere's own sequence presets"],
      ["q2", { command: "duplicate_sequence", args: { timeline: "Main", name: "two\nlines" } }, "timeline must name a sequence in one short line"],
      ["q3", { command: "open_sequence", args: {} }, "timeline must name a sequence in one short line"],
      ["q4", { command: "select_items", args: { timeline: "Main", ids: ["n1"], additive: "yes" } }, "additive must be true or false"],
      ["q5", { command: "select_project_items", args: { ids: [] } }, "ids must list 1 to 64 project items"],
      ["q6", { command: "read_project", args: { usage: 1 } }, "usage must be true or false"],
      ["q7", { command: "project_item_info", args: { id: "../x" } }, "id must be a project item id"],
    ];
    for (const [id, request] of cases) writeJob(dir, { id, ...request });
    await panel.context.poll();
    for (const [id, , error] of cases) expect(readJson(path.join(dir, "replies", `${id}.json`)).error).toBe(error);
    expect(panel.scripts).toEqual([]);
  });

  it("reads the project through vcReadProject", async () => {
    const panel = loadPanel(dir, () => JSON.stringify({ ok: true, result: { root: "Doc", bins: [], items: [] } }));
    writeJob(dir, { id: "r1", command: "read_project", args: { timeline: "Main" } });
    await panel.context.poll();
    expect(readJson(path.join(dir, "replies", "r1.json")).result).toEqual({ root: "Doc", bins: [], items: [] });
    expect(panel.scripts[0]).toContain('vcReadProject({"timeline":"Main"})');
  });

  it("imports only sequences written into its own imports folder (Phase 6b)", async () => {
    fs.mkdirSync(path.join(dir, "imports"), { recursive: true });
    const ours = path.join(dir, "imports", "rebuild-1.xml");
    fs.writeFileSync(ours, "<xmeml/>");
    const elsewhere = path.join(dir, "evil.xml");
    fs.writeFileSync(elsewhere, "<xmeml/>");
    const panel = loadPanel(dir, () => JSON.stringify({ ok: true, result: { name: "Cut (VibeCut 1)" } }));
    writeJob(dir, { id: "x1", command: "import_sequence", args: { path: elsewhere, name: "Cut", bin: "VibeCut" } });
    writeJob(dir, { id: "x2", command: "import_sequence", args: { path: ours, name: "Cut", bin: "../x" } });
    await panel.context.poll();
    expect(readJson(path.join(dir, "replies", "x1.json")).error).toBe("Only VibeCut Agent's own rebuilt sequences can be imported");
    expect(readJson(path.join(dir, "replies", "x2.json")).error).toBe("bin must be a short name");
    writeJob(dir, { id: "x3", command: "import_sequence", args: { path: ours, name: "Cut", bin: "VibeCut" } });
    await panel.context.poll();
    expect(readJson(path.join(dir, "replies", "x3.json")).result).toEqual({ name: "Cut (VibeCut 1)" });
    expect(panel.scripts[0]).toContain("vcImportSequence(");
  });

  it("checks link groups before calling Premiere (Phase 6c)", async () => {
    const panel = loadPanel(dir, () => JSON.stringify({ ok: true, result: {} }));
    writeJob(dir, { id: "l1", command: "set_links", args: { timeline: "Main", unlink: ["n1"], groups: [["n1"]] } });
    writeJob(dir, { id: "l2", command: "set_links", args: { timeline: "Main", unlink: ["n1", "n2"], groups: [["n1", "n2"]] } });
    await panel.context.poll();
    expect(readJson(path.join(dir, "replies", "l1.json")).error).toBe("groups[0] must list 2 to 64 clips");
    expect(readJson(path.join(dir, "replies", "l2.json")).ok).toBe(true);
    expect(panel.scripts[0]).toContain("vcSetLinks(");
  });

  it("clears requests a previous Premiere left half-done", () => {
    fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "jobs", "old.json.running"), "{}");
    loadPanel(dir, () => "");
    expect(fs.readdirSync(path.join(dir, "jobs"))).toEqual([]);
  });
});
