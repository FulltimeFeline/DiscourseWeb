# Third-party notices

Discourse for Matrix (web) is MIT-licensed (see `LICENSE`). It builds on the
open-source projects below, each under its own license. This file is provided as
attribution; refer to each project for its full license text.

## Bundled at runtime

- **Matrix Rust SDK** — Apache License 2.0 — https://github.com/matrix-org/matrix-rust-sdk
  Compiled to WebAssembly and shipped in the app; the core sync, crypto, and
  event store.
- **React** — MIT — https://github.com/facebook/react
- **Vite** — MIT — https://github.com/vitejs/vite
- **Electron** (desktop build only) — MIT — https://github.com/electron/electron

## Embedded, not bundled

- **Element Call** — AGPL-3.0 — https://github.com/element-hq/element-call
  Loaded as a hosted widget in an iframe for voice/video calls; its code is not
  redistributed with this app.

## Conventions and references

- Extended-profile field keys follow the **Commet** and **Element** conventions
  so profiles interoperate across the ecosystem.

Other direct and transitive dependencies are listed in `package.json` /
`package-lock.json`, each under its respective open-source license.
