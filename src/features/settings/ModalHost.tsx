// Mounts whatever modal the ModalManager currently has open. Render this ONCE
// near the app root (inside the SessionProvider, since the sheets use
// useSession/useApp). Everything else just calls `modals.open*()`.

import { useViewModel } from "@/core/reactive";
import { modals } from "./ModalManager";
import { SettingsSheet } from "./SettingsSheet";
import { RoomSettingsSheet } from "./RoomSettingsSheet";
import { ProfileSheet } from "@/features/profile/ProfileSheet";
import { InviteSheet } from "./InviteSheet";

export function ModalHost() {
  const s = useViewModel(modals);
  return (
    <>
      {s.settings && <SettingsSheet initialTab={s.settings.tab} onClose={() => modals.closeSettings()} />}
      {s.roomSettings && <RoomSettingsSheet roomId={s.roomSettings.roomId} onClose={() => modals.closeRoomSettings()} />}
      {s.profile && <ProfileSheet userId={s.profile.userId} onClose={() => modals.closeProfile()} />}
      {s.invite && (
        <InviteSheet roomId={s.invite.roomId} roomName={s.invite.roomName} onClose={() => modals.closeInvite()} />
      )}
    </>
  );
}
