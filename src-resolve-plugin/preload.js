"use strict";

// The VibeCut Agent window's bridge to its main process (PLAN.md, "In-host panels"). The panel
// (src-premiere-panel-ui/electron.tsx) sees only these; the main process checks every path, and a drag
// names a B-roll shot's key only.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vibecutPanel", {
  chatDir: ipcRenderer.sendSync("panel:chatDir"),
  readText: (path) => ipcRenderer.invoke("panel:readText", path),
  writeText: (path, text) => ipcRenderer.invoke("panel:writeText", path, text),
  rename: (from, to) => ipcRenderer.invoke("panel:rename", from, to),
  makeDir: (path) => ipcRenderer.invoke("panel:makeDir", path),
  startDrag: (key) => ipcRenderer.send("panel:startDrag", key),
  chooseFolder: (current) => ipcRenderer.invoke("panel:chooseFolder", current),
  copyText: (text) => ipcRenderer.invoke("panel:copyText", text),
});
