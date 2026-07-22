// Public entry points for the Settings / Room-settings / Profile surface.
// The shell mounts <ModalHost/> once (inside SessionProvider) and drops
// <SettingsButton/> into the rail; everything else opens sheets via `modals`.

export { modals } from "./ModalManager";
export type { SettingsTab } from "./ModalManager";
export { ModalHost } from "./ModalHost";
export { SettingsButton } from "./SettingsButton";
export { SettingsSheet } from "./SettingsSheet";
export { RoomSettingsSheet } from "./RoomSettingsSheet";
export { settingsPrefs } from "./settingsPrefs";
