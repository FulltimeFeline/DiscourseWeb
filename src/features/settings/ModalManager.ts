// A tiny modal manager so any feature can open Settings, Room Settings, or a
// user Profile sheet without threading callbacks through the tree. It's a plain
// ViewModel (the project's reactive base) holding "what modal is open"; the
// shell renders <ModalHost/> once near the root and everything else calls
// `modals.openSettings()` / `openRoomSettings(roomId)` / `openProfile(userId)`.
//
// Kept feature-import-free (only ids + an initial tab), so it can live at the
// app root without pulling in the heavy sheets until they mount.

import { ViewModel } from "@/core/reactive";

export type SettingsTab =
  | "account"
  | "accounts"
  | "appearance"
  | "chat"
  | "privacy"
  | "notifications"
  | "accessibility"
  | "stickers"
  | "storage"
  | "advanced"
  | "about";

interface ModalSnapshot {
  settings: { tab: SettingsTab } | null;
  roomSettings: { roomId: string } | null;
  profile: { userId: string } | null;
  invite: { roomId: string; roomName: string } | null;
}

export class ModalManager extends ViewModel<ModalSnapshot> {
  constructor() {
    super({ settings: null, roomSettings: null, profile: null, invite: null });
  }

  openInvite(roomId: string, roomName: string): void {
    this.setState({ invite: { roomId, roomName } });
  }
  closeInvite(): void {
    this.setState({ invite: null });
  }

  openSettings(tab: SettingsTab = "account"): void {
    this.setState({ settings: { tab } });
  }
  closeSettings(): void {
    this.setState({ settings: null });
  }

  openRoomSettings(roomId: string): void {
    this.setState({ roomSettings: { roomId } });
  }
  closeRoomSettings(): void {
    this.setState({ roomSettings: null });
  }

  openProfile(userId: string): void {
    this.setState({ profile: { userId } });
  }
  closeProfile(): void {
    this.setState({ profile: null });
  }
}

/** App-wide singleton. Import and call from anywhere; render <ModalHost/> once. */
export const modals = new ModalManager();
