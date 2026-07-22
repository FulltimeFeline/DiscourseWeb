// Minimal preload. contextIsolation + sandbox are on, so the renderer has no
// Node access; expose only a tiny, safe surface the web app can feature-detect.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("discourseDesktop", {
  platform: process.platform,
  isElectron: true,
});
