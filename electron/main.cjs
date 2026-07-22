// Electron main process. Hosts the built web app under a custom `app://` scheme
// registered as standard + secure, so the renderer gets a stable, HTTPS-like
// origin — required for the Matrix SDK's IndexedDB crypto store to persist and
// for the ~48MB WASM module to load (file:// origins break both). In dev it
// loads the Vite server instead (ELECTRON_RENDERER_URL).

const { app, BrowserWindow, protocol, net, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DIST = path.join(__dirname, "..", "dist");
const APP_ORIGIN = "app://bundle";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 720,
    minHeight: 500,
    backgroundColor: "#0b0b0d",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadURL(`${APP_ORIGIN}/index.html`);
  }

  // Open external links (matrix.to fallbacks, OIDC, help) in the system browser,
  // not inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

app.whenReady().then(() => {
  // Serve dist/ over app://; unknown non-asset paths fall back to index.html so
  // the SPA router (and /oidc/callback, /sso/callback) works.
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname === "") pathname = "/index.html";
    const target = path.normalize(path.join(DIST, pathname));
    if (!target.startsWith(DIST)) return new Response("Forbidden", { status: 403 });
    try {
      return await net.fetch(pathToFileURL(target).toString());
    } catch {
      return net.fetch(pathToFileURL(path.join(DIST, "index.html")).toString());
    }
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
