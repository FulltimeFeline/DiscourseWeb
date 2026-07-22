// Invite people to a room or space: a user-search sheet with debounced
// directory search and a raw @user:server fallback. Invites go through
// RoomListViewModel.

import { useCallback, useEffect, useRef, useState } from "react";
import { useApp, useSession } from "@/app/context";
import { useRoomListScope } from "@/features/roomlist/scope";
import { RoomAvatar } from "@/features/roomlist/RoomAvatar";
import type { UserProfile } from "@/matrix";
import { Icon } from "@/ui/Icon";

export function InviteSheet({
  roomId,
  roomName,
  onClose,
}: {
  roomId: string;
  roomName: string;
  onClose: () => void;
}) {
  const app = useApp();
  const session = useSession();
  const scope = useRoomListScope(app, session);
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [invited, setInvited] = useState<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const search = useCallback(
    (t: string) => {
      clearTimeout(timer.current);
      const q = t.trim();
      if (!q) {
        setResults([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      timer.current = setTimeout(async () => {
        let hits: UserProfile[] = [];
        try {
          hits = (await session.client.searchUsers(q, 10n)).results;
        } catch {
          hits = [];
        }
        if (/^@[^:]+:.+/.test(q) && !hits.some((h) => h.userId === q)) {
          hits = [{ userId: q, displayName: undefined, avatarUrl: undefined }, ...hits];
        }
        setResults(hits);
        setLoading(false);
      }, 300);
    },
    [session],
  );

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const invite = (userId: string) => {
    setInvited((s) => new Set(s).add(userId));
    void scope.roomList.inviteUser(roomId, userId);
  };

  return (
    <div className="cmp-scrim" onMouseDown={onClose} role="presentation">
      <div className="cmp-panel" role="dialog" aria-label={`Invite to ${roomName}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmp-body">
          <div className="cmp-invite-head">
            <h2 className="cmp-invite-title">Invite to {roomName}</h2>
            <button className="cmp-invite-close" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
          </div>
          <input
            className="cmp-input"
            autoFocus
            placeholder="Search people or @user:server"
            value={term}
            onChange={(e) => {
              setTerm(e.target.value);
              search(e.target.value);
            }}
          />
          <div className="cmp-results" role="listbox">
            {loading && <div className="cmp-hint">Searching…</div>}
            {!loading && term.trim() && results.length === 0 && <div className="cmp-hint">No people found</div>}
            {results.map((u) => (
              <div key={u.userId} className="cmp-user">
                <RoomAvatar name={u.displayName ?? u.userId} avatarUrl={u.avatarUrl} size={30} />
                <span className="cmp-user-text">
                  <span className="cmp-user-name">{u.displayName ?? u.userId}</span>
                  {u.displayName && <span className="cmp-user-sub">{u.userId}</span>}
                </span>
                <button
                  className="cmp-btn cmp-btn--primary"
                  disabled={invited.has(u.userId)}
                  onClick={() => invite(u.userId)}
                >
                  {invited.has(u.userId) ? "Invited" : "Invite"}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
