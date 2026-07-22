// Global search: people (searchUsers) + public room directory (REST) + message
// search. Results are selectable: start a DM (person), join/open a room, or jump
// to a message.
//
// Rendered as a modal overlay; MainShell opens it (e.g. from a search button or
// a shortcut). Deep-link paste (matrix.to / #alias / !id) routes immediately.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp, useSession } from "@/app/context";
import type { UserProfile } from "@/matrix";
import { RoomAvatar } from "@/features/quickswitcher/RoomAvatar";
import { startDirectMessage, joinByAddress } from "@/features/compose/ComposeViewModel";
import { navigateToPermalink } from "@/core/notifications/navigate";
import { useRoomListScope } from "@/features/roomlist/scope";
import {
  searchPublicRooms,
  searchUsers,
  searchMessages,
  type DirectoryRoom,
  type MessageHit,
} from "./SearchViewModel";
import "./search.css";

export function SearchView({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const session = useSession();
  const scope = useRoomListScope(app, session);
  const [term, setTerm] = useState("");
  const [people, setPeople] = useState<UserProfile[]>([]);
  const [rooms, setRooms] = useState<DirectoryRoom[]>([]);
  const [messages, setMessages] = useState<MessageHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const roomName = useCallback(
    (roomId: string) => scope.roomList.state.rooms.find((r) => r.id === roomId)?.name ?? roomId,
    [scope],
  );
  const jumpToMessage = (hit: MessageHit) => {
    app.selectRoom(hit.roomId);
    window.dispatchEvent(
      new CustomEvent("discourse:jump-to-event", { detail: { roomId: hit.roomId, eventId: hit.eventId } }),
    );
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = useCallback(
    (q: string) => {
      clearTimeout(timer.current);
      const query = q.trim();
      if (!query) {
        setPeople([]);
        setRooms([]);
        setMessages([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      timer.current = setTimeout(async () => {
        const [p, r, m] = await Promise.all([
          searchUsers(session, query),
          searchPublicRooms(session, query),
          searchMessages(session, query),
        ]);
        setPeople(p);
        setRooms(r.rooms);
        setMessages(m.hits);
        setLoading(false);
      }, 300);
    },
    [session],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  const onChange = (q: string) => {
    setTerm(q);
    run(q);
  };

  // Pasting a permalink / address routes straight to the room.
  const onKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    const q = term.trim();
    if (/^(https?:\/\/matrix\.to|matrix:|[#!])/.test(q)) {
      e.preventDefault();
      const res = q.startsWith("#") || q.startsWith("!")
        ? { ok: !!(await joinRoom(q)) }
        : await navigateToPermalink(app, session, q);
      if (res.ok) onClose();
    }
  };

  const openDm = async (userId: string) => {
    setBusyId(userId);
    try {
      const roomId = await startDirectMessage(session, userId);
      app.selectRoom(roomId);
      onClose();
    } finally {
      setBusyId(undefined);
    }
  };

  const joinRoom = async (address: string): Promise<string | undefined> => {
    setBusyId(address);
    try {
      const roomId = await joinByAddress(session, address);
      app.selectRoom(roomId);
      onClose();
      return roomId;
    } catch {
      return undefined;
    } finally {
      setBusyId(undefined);
    }
  };

  const hasQuery = term.trim().length > 0;

  return (
    <div className="srch-scrim" onMouseDown={onClose} role="presentation">
      <div
        className="srch-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          className="srch-input"
          autoFocus
          placeholder="Search people, rooms, or paste a link…"
          value={term}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="srch-results">
          {loading && <div className="srch-hint">Searching…</div>}

          {hasQuery && people.length > 0 && (
            <section>
              <h3 className="srch-heading">People</h3>
              {people.map((u) => (
                <button
                  type="button"
                  key={u.userId}
                  className="srch-row"
                  disabled={busyId === u.userId}
                  onClick={() => openDm(u.userId)}
                >
                  <RoomAvatar name={u.displayName || u.userId} avatarUrl={u.avatarUrl} />
                  <span className="srch-row-text">
                    <span className="srch-row-name">{u.displayName || u.userId}</span>
                    <span className="srch-row-sub">{u.userId}</span>
                  </span>
                  <span className="srch-action">Message</span>
                </button>
              ))}
            </section>
          )}

          {hasQuery && rooms.length > 0 && (
            <section>
              <h3 className="srch-heading">Rooms</h3>
              {rooms.map((r) => (
                <button
                  type="button"
                  key={r.roomId}
                  className="srch-row"
                  disabled={busyId === (r.alias || r.roomId)}
                  onClick={() => joinRoom(r.alias || r.roomId)}
                >
                  <RoomAvatar name={r.name || r.alias || r.roomId} avatarUrl={r.avatarUrl} />
                  <span className="srch-row-text">
                    <span className="srch-row-name">{r.name || r.alias || r.roomId}</span>
                    <span className="srch-row-sub">
                      {r.alias ?? r.roomId} · {r.numMembers} members
                    </span>
                  </span>
                  <span className="srch-action">Join</span>
                </button>
              ))}
            </section>
          )}

          {hasQuery && messages.length > 0 && (
            <section>
              <h3 className="srch-heading">Messages</h3>
              {messages.map((m) => (
                <button
                  type="button"
                  key={m.eventId}
                  className="srch-row"
                  onClick={() => jumpToMessage(m)}
                >
                  <RoomAvatar name={roomName(m.roomId)} />
                  <span className="srch-row-text">
                    <span className="srch-row-name">{m.body || "(no text)"}</span>
                    <span className="srch-row-sub">
                      {roomName(m.roomId)} · {new Date(m.ts).toLocaleDateString()}
                    </span>
                  </span>
                  <span className="srch-action">Open</span>
                </button>
              ))}
            </section>
          )}

          {hasQuery && !loading && people.length === 0 && rooms.length === 0 && messages.length === 0 && (
            <div className="srch-hint">No results found.</div>
          )}

          <div className="srch-note">
            Message search covers unencrypted rooms (the server can’t index
            end-to-end encrypted content). Use in-room search (⌘F) inside an
            encrypted room.
          </div>
        </div>
      </div>
    </div>
  );
}
