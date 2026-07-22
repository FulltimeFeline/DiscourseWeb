// Single entry point for the Matrix Rust SDK (compiled to WebAssembly).
//
// The generated uniffi bindings and the wasm module live under ./generated,
// produced by uniffi-bindgen-react-native from matrix-sdk-ffi. `Client`,
// `SyncService`, `RoomListService`, `Room`, `Timeline`, `Encryption`, etc. all
// come from that FFI surface.
//
// `uniffiInitAsync()` must be awaited once, before any SDK type is touched
// (see main.tsx). It fetches and instantiates the wasm and registers the uniffi
// checksums/callbacks.
export * from "./index.web";
export { default as sdk } from "./index.web";
