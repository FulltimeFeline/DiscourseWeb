import { useViewModel } from "@/core/reactive";
import { Icon } from "@/ui/Icon";
import type { TimelineViewModel } from "./TimelineViewModel";

interface Props {
  vm: TimelineViewModel;
  roomId: string;
  onToggleDetails?: () => void;
  onOpenSearch?: () => void;
  onBack?: () => void;
}

export function RoomHeader({ vm, roomId, onToggleDetails, onOpenSearch, onBack }: Props) {
  const state = useViewModel(vm);

  const startCall = () =>
    window.dispatchEvent(
      new CustomEvent("discourse:open-call", {
        detail: { roomId, roomName: state.roomName, joinExisting: state.hasActiveCall },
      }),
    );

  return (
    <div className="room-header">
      <button className="room-header__back" aria-label="Back" onClick={onBack}>
        <Icon name="chevron-left" size={22} />
      </button>
      <div className="room-header__titles">
        <div className="room-header__name">
          {state.isEncrypted && (
            <span className="room-header__lock" title="Encrypted">
              <Icon name="lock" />
            </span>
          )}
          {state.roomName}
        </div>
        {state.topic && <div className="room-header__topic">{state.topic}</div>}
      </div>
      <div className="room-header__spacer" />
      <div className="room-header__actions">
        <button className="room-header__action" title="Call" aria-label="Call" onClick={startCall}>
          <Icon name="phone" size={18} />
        </button>
        <button
          className="room-header__action"
          title="Search in conversation"
          aria-label="Search"
          onClick={onOpenSearch}
        >
          <Icon name="search" size={18} />
        </button>
        <button
          className="room-header__action"
          title="Details"
          aria-label="Details"
          onClick={onToggleDetails}
        >
          <Icon name="info" size={18} />
        </button>
      </div>
    </div>
  );
}
