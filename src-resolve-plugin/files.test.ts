// @vitest-environment node
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface FileOps {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  makeDir(path: string): Promise<void>;
}

// The plugin's main process runs plain CommonJS as Resolve loads it, so it's required, not imported.
const { chatDir, createFileOps, createPanelOps, dragTarget, MAX_READ_BYTES, MAX_WRITE_BYTES } = createRequire(import.meta.url)("./files.js") as {
  chatDir(home?: string): string;
  createFileOps(root: string): FileOps;
  createPanelOps(root: string): FileOps;
  dragTarget(root: string, key: unknown): { file: string; icon: string | null } | null;
  MAX_READ_BYTES: number;
  MAX_WRITE_BYTES: number;
};

let scratch: string;
let dir: string;
let ops: FileOps;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "vca-resolve-plugin-"));
  dir = chatDir(scratch);
  ops = createFileOps(dir);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("the Resolve window's file operations", () => {
  it("is VibeCut Agent's chat folder for Resolve, never VibeCut's", () => {
    expect(chatDir("/Users/me")).toBe("/Users/me/Library/Application Support/VibeCut Agent/host-bridge/chat/resolve");
  });

  it("makes the folder, writes, renames into place and reads back, with a missing file as null", async () => {
    await ops.makeDir(`${dir}/inbox`);
    await ops.writeText(`${dir}/inbox/.a1.json.tmp`, '{"id":"a1"}');
    await ops.rename(`${dir}/inbox/.a1.json.tmp`, `${dir}/inbox/a1.json`);
    expect(await ops.readText(`${dir}/inbox/a1.json`)).toBe('{"id":"a1"}');
    expect(await ops.readText(`${dir}/state.json`)).toBeNull();
    expect(await ops.readText(`${dir}/inbox`)).toBeNull();
  });

  it("refuses anything outside the chat folder, however it's spelled", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(scratch, "secret.txt"), "no");
    await expect(ops.readText(join(scratch, "secret.txt"))).rejects.toThrow(/Outside/);
    await expect(ops.readText(`${dir}/../../secret.txt`)).rejects.toThrow(/Outside/);
    await expect(ops.readText(`${dir}/../premiere/state.json`)).rejects.toThrow(/Outside/);
    await expect(ops.writeText("/tmp/vca-escape.json", "{}")).rejects.toThrow(/Outside/);
    await expect(ops.rename(`${dir}/state.json`, join(scratch, "moved.json"))).rejects.toThrow(/Outside/);
    await expect(ops.makeDir(join(scratch, "elsewhere"))).rejects.toThrow(/Outside/);
    await expect(ops.readText("")).rejects.toThrow(/Not a path/);
    await expect(ops.readText(`${dir}/a\0b`)).rejects.toThrow(/Not a path/);
  });

  it("never follows a symlink, inside the folder or as the folder", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(scratch, "secret.txt"), "no");
    symlinkSync(join(scratch, "secret.txt"), join(dir, "state.json"));
    await expect(ops.readText(`${dir}/state.json`)).rejects.toThrow(/symlink/);
    await expect(ops.writeText(`${dir}/state.json`, "{}")).rejects.toThrow(/symlink/);
    expect(readFileSync(join(scratch, "secret.txt"), "utf8")).toBe("no");

    const linked = join(scratch, "linked");
    mkdirSync(join(scratch, "real"));
    symlinkSync(join(scratch, "real"), linked);
    const viaLink = createFileOps(linked);
    await expect(viaLink.makeDir(`${linked}/inbox`)).rejects.toThrow(/symlink/);
  });

  it("caps what it reads and writes, and writes only text", async () => {
    mkdirSync(dir, { recursive: true });
    await expect(ops.writeText(`${dir}/big.json`, "x".repeat(MAX_WRITE_BYTES + 1))).rejects.toThrow(/too big/);
    await expect(ops.writeText(`${dir}/n.json`, 5 as unknown as string)).rejects.toThrow(/Only text/);
    writeFileSync(join(dir, "state.json"), "x".repeat(MAX_READ_BYTES + 1));
    await expect(ops.readText(`${dir}/state.json`)).rejects.toThrow(/too big/);
  });
});

describe("what the page may write, and dragging a B-roll shot", () => {
  it("lets the page write only its inbox actions and its heartbeat", async () => {
    const panel = createPanelOps(dir);
    await panel.makeDir(`${dir}/inbox`);
    await panel.writeText(`${dir}/inbox/.a1.json.tmp`, "{}");
    await panel.rename(`${dir}/inbox/.a1.json.tmp`, `${dir}/inbox/a1.json`);
    await panel.writeText(`${dir}/panel-alive.json`, "{}");
    await expect(panel.writeText(`${dir}/broll.json`, "{}")).rejects.toThrow(/can't write/);
    await expect(panel.writeText(`${dir}/state.json`, "{}")).rejects.toThrow(/can't write/);
    await expect(panel.writeText(`${dir}/thumbs/s1.txt`, "x")).rejects.toThrow(/can't write/);
    await expect(panel.rename(`${dir}/inbox/a1.json`, `${dir}/broll.json`)).rejects.toThrow(/can't write/);
    await expect(panel.makeDir(`${dir}/thumbs`)).rejects.toThrow(/can't make/);
    expect(await panel.readText(`${dir}/inbox/a1.json`)).toBe("{}");
  });

  it("drags only a plain media file the app listed for that key, with the shot's picture", () => {
    mkdirSync(join(dir, "thumbs"), { recursive: true });
    const media = join(scratch, "sky.mov");
    writeFileSync(media, "movie");
    writeFileSync(join(scratch, "notes.txt"), "text");
    symlinkSync(media, join(scratch, "link.mov"));
    writeFileSync(join(dir, "thumbs", "s1.txt"), "data:image/jpeg;base64,AAAA");
    writeFileSync(
      join(dir, "broll.json"),
      JSON.stringify({
        shots: [{ key: "r1", thumb: "s1.txt" }, { key: "r2" }],
        pool: [],
        paths: { r1: media, r2: media, r3: join(scratch, "notes.txt"), r4: join(scratch, "link.mov"), r5: "relative.mov", r6: join(scratch, "missing.mov") },
      }),
    );
    expect(dragTarget(dir, "r1")).toEqual({ file: media, icon: "data:image/jpeg;base64,AAAA" });
    expect(dragTarget(dir, "r2")).toEqual({ file: media, icon: null });
    for (const key of ["r3", "r4", "r5", "r6", "r9", "../r1", "__proto__", 7]) expect(dragTarget(dir, key)).toBeNull();
  });
});

