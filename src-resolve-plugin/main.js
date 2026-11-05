"use strict";

/**
 * VibeCut Agent, DaVinci Resolve Studio's Workflow Integration plugin `com.vibecutagent.resolve`
 * (PLAN.md, "In-host panels"; ported from VibeCut's `com.vibecut.agent`): the menu-bar app's chat,
 * B-roll and history in a window of its own (Workspace › Workflow Integrations › VibeCut Agent). The app
 * stays the brain and drives Resolve itself; this window only reads and writes the chat files in
 * VibeCut Agent's Application Support folder, so it needs no WorkflowIntegration.node, no network and
 * no Node in the page.
 */

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, session } = require("electron");
const path = require("path");
const { chatDir, createFileOps, createPanelOps, dragTarget } = require("./files");

const CHAT_DIR = chatDir();
const files = createFileOps(CHAT_DIR);
/** What the page may do: read the folder, write only its inbox and heartbeat. */
const panelFiles = createPanelOps(CHAT_DIR);
/** A drag's icon when the shot has no picture: a 16×9 grey frame. */
const PLAIN_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAYAAAA7KqwyAAAAFklEQVR42mPQsQv9TwlmGDVg1AAgBgD/bPrhh38kIQAAAABJRU5ErkJggg==";
const WINDOW_FILE = path.join(CHAT_DIR, "window.json");
const INDEX = path.join(__dirname, "index.html");

let mainWindow = null;

/** Only our own page may call the file operations. */
function fromPanel(event) {
  return !!mainWindow && event.sender === mainWindow.webContents;
}

function registerHandlers() {
  ipcMain.on("panel:chatDir", (event) => {
    event.returnValue = fromPanel(event) ? CHAT_DIR : "";
  });
  const handle = (channel, operation) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromPanel(event)) throw new Error("Refused");
      return operation(...args);
    });
  handle("panel:readText", (p) => panelFiles.readText(p));
  handle("panel:writeText", (p, text) => panelFiles.writeText(p, text));
  handle("panel:rename", (from, to) => panelFiles.rename(from, to));
  handle("panel:makeDir", (p) => panelFiles.makeDir(p));
  // The Analyze tab's folder: chosen in Resolve's own dialog, so the page never types a path.
  handle("panel:chooseFolder", async (current) => {
    const options = { title: "Choose a folder of B-roll", properties: ["openDirectory"] };
    if (typeof current === "string" && path.isAbsolute(current)) options.defaultPath = current;
    const picked = await dialog.showOpenDialog(mainWindow, options);
    return picked.canceled || !picked.filePaths.length ? null : picked.filePaths[0];
  });
  // A message's Copy: text only, at most what an action may carry.
  handle("panel:copyText", (text) => {
    if (typeof text === "string" && text.length <= 64 * 1024) clipboard.writeText(text);
  });
  // A B-roll shot dragged out of the window: a real file drag, so it drops into Resolve's Media Pool or
  // timeline as from Finder. The page names only the shot's key; the file comes from the app's own
  // broll.json, and must be a plain media file.
  ipcMain.on("panel:startDrag", (event, key) => {
    if (!fromPanel(event)) return;
    const target = dragTarget(CHAT_DIR, key);
    if (!target) return;
    let icon = nativeImage.createFromDataURL(target.icon || PLAIN_ICON);
    if (icon.isEmpty()) icon = nativeImage.createFromDataURL(PLAIN_ICON);
    else if (target.icon) icon = icon.resize({ width: 96 });
    event.sender.startDrag({ file: target.file, icon });
  });
}

/**
 * The plugin's own menu bar. On macOS the editing keys (⌘C, ⌘V, ⌘X, ⌘Z, ⇧⌘Z, ⌘A) come from the Edit
 * menu's roles, and Resolve starts this process with no menu at all, so without this the window's text
 * fields can't copy, paste or undo.
 */
function editMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "VibeCut Agent", submenu: [{ role: "hide" }, { role: "hideOthers" }, { type: "separator" }, { role: "close" }] },
      {
        label: "Edit",
        submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" }],
      },
    ]),
  );
}

/** No network and no other pages: only files from this plugin load. */
function lockDown() {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith("file:") && !details.url.startsWith("devtools:") });
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

async function savedBounds() {
  try {
    const bounds = JSON.parse((await files.readText(WINDOW_FILE)) || "null");
    const ok = bounds && ["x", "y", "width", "height"].every((key) => Number.isFinite(bounds[key]));
    return ok ? { x: bounds.x, y: bounds.y, width: Math.max(300, bounds.width), height: Math.max(360, bounds.height) } : null;
  } catch {
    return null;
  }
}

let saveTimer = null;
function saveBoundsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      await files.makeDir(CHAT_DIR);
      await files.writeText(WINDOW_FILE, JSON.stringify(mainWindow.getBounds()));
    } catch {
      // Only the window's place is lost.
    }
  }, 500);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 720,
    minWidth: 300,
    minHeight: 360,
    ...(await savedBounds()),
    title: "VibeCut Agent",
    backgroundColor: "#0d1117", // the window's canvas (panel.css --vc-panel)
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      // Behind Resolve or the app, the window must keep reading the app's state and stamping its
      // heartbeat (VibeCut's live check: with throttling on, both stopped until Resolve came forward).
      backgroundThrottling: false,
    },
  });
  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.on("move", saveBoundsSoon);
  mainWindow.on("resize", saveBoundsSoon);
  mainWindow.on("close", () => app.quit());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadFile(INDEX);
}

app.whenReady().then(() => {
  editMenu();
  registerHandlers();
  lockDown();
  return createWindow();
});

app.on("window-all-closed", () => app.quit());
