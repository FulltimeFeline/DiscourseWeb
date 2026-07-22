# Discourse Desktop (Electron)

The web client can be packaged as a desktop app (Windows / macOS / Linux) via
Electron. Electron hosts the built `dist/` under a custom `app://` scheme
registered as **standard + secure**, giving the renderer a stable HTTPS-like
origin — required so the Matrix SDK's IndexedDB crypto store persists between
launches and the ~48 MB WASM module loads (a `file://` origin breaks both).

## Install the desktop toolchain

```bash
cd web
npm install       # picks up electron, electron-builder, etc. (added to devDeps)
```

## Develop

```bash
npm run electron:dev      # Vite dev server + Electron window with devtools
```

## Build installers

```bash
npm run electron:build        # current platform
npm run electron:build:win    # Windows (nsis installer + portable .exe)
```

Output lands in `web/release/`.

### Building the Windows app

`electron-builder --win` produces an NSIS installer and a portable `.exe`.
Build it **on Windows** or in **CI** (e.g. a GitHub Actions `windows-latest`
runner) for a clean result — cross-building Windows from macOS/Linux needs Wine
and is fiddly. A minimal CI job:

```yaml
jobs:
  win:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd web && npm ci && npm run electron:build:win
      - uses: actions/upload-artifact@v4
        with: { name: discourse-win, path: web/release/*.exe }
```

## Notes / limitations

- **Auth:** password login works out of the box. The **SSO popup** and **OIDC
  full-page redirect** flows assume a browser context and don't round-trip
  cleanly inside Electron yet — external auth opens in the system browser but
  can't hand the callback back to the app window. A desktop deep-link
  (custom protocol + `app.setAsDefaultProtocolClient`) would close that gap.
- **Background push** stays gated on the same `VITE_*` env + push gateway as the
  web build; foreground notifications use Electron's native Notification API.
- The app icon uses `public/icon.png`; supply a higher-res `.ico`/`.icns` for
  polished installers.
