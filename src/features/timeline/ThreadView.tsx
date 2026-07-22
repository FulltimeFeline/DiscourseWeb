import { useCallback, useEffect, useState } from "react";
import type { EventEntry, RoomSummary } from "@/models/types";
import { useSession } from "@/app/context";
import { TimelineViewModel } from "./TimelineViewModel";
import { TimelineView } from "./TimelineView";
import { Composer, type ComposerEditTarget, type ComposerReplyTarget } from "./Composer";
import { Icon } from "@/ui/Icon";

interface Props {
  roomId: string;
  rootEventId: string;
  room: RoomSummary;
  onClose: () => void;
}

/**
 * A thread panel with its own thread-focused timeline (TimelineFocus.Thread) and
 * its own composer that sends into the thread. The VM is created inside the
 * effect (not useMemo) so React StrictMode's mount/unmount/mount can't leave the
 * surviving mount running a disposed VM (which would never load the thread).
 */
export function ThreadView({ roomId, rootEventId, room, onClose }: Props) {
  const session = useSession();
  const [vm, setVm] = useState<TimelineViewModel | undefined>(undefined);
  const [reply, setReply] = useState<ComposerReplyTarget | undefined>();
  const [edit, setEdit] = useState<ComposerEditTarget | undefined>();

  useEffect(() => {
    const r = session.getRoom(roomId);
    if (!r) return;
    const v = new TimelineViewModel(session, r, roomId, { type: "thread", rootEventId });
    setVm(v);
    void v.start();
    return () => v.dispose();
  }, [session, roomId, rootEventId]);

  const startReply = useCallback((e: EventEntry) => {
    setEdit(undefined);
    if (e.eventId) {
      setReply({
        eventId: e.eventId,
        senderName: e.senderProfile.displayName ?? e.sender,
        body: "body" in e.content ? e.content.body : "",
      });
    }
  }, []);
  const startEdit = useCallback((e: EventEntry) => {
    setReply(undefined);
    if (e.eventId) setEdit({ eventId: e.eventId, body: "body" in e.content ? e.content.body : "" });
  }, []);

  // Stable getter for the thread timeline so the composer sends into the thread.
  const sendTimeline = useCallback(() => vm?.getTimeline(), [vm]);

  return (
    <div className="thread-panel">
      <div className="thread-panel__header">
        <span>Thread</span>
        <button className="thread-panel__close" onClick={onClose} aria-label="Close thread">
          <Icon name="x" size={16} />
        </button>
      </div>
      {vm ? (
        <>
          <TimelineView
            vm={vm}
            ownUserId={session.userId}
            onReply={startReply}
            onEdit={startEdit}
            onOpenThread={() => {
              /* already in a thread */
            }}
          />
          <Composer
            room={room}
            session={session}
            sendTimeline={sendTimeline}
            replyTarget={reply}
            editTarget={edit}
            onClearReply={() => setReply(undefined)}
            onClearEdit={() => setEdit(undefined)}
          />
        </>
      ) : (
        <div className="thread-panel__body" />
      )}
    </div>
  );
}
