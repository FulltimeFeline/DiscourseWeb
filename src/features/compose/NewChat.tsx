// New-chat entry point: a modal with four modes (new DM, new room, new space,
// join by address). User search is debounced 300ms via client.searchUsers, and
// also accepts a raw `@user:server` the directory misses.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp, useSession } from "@/app/context";
import type { UserProfile } from "@/matrix";
import { RoomAvatar } from "@/features/quickswitcher/RoomAvatar";
import {
  createRoom,
  createVideoRoom,
  createSpace,
  joinByAddress,
  startDirectMessage,
} from "./ComposeViewModel";
import "./compose.css";

type Mode = "dm" | "room" | "space" | "join";

export function NewChat({
  initialMode = "dm",
  onClose,
}: {
  initialMode?: Mode;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);

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

  return (
    <div className="cmp-scrim" onMouseDown={onClose} role="presentation">
      <div
        className="cmp-panel"
        role="dialog"
        aria-modal="true"
        aria-label="New conversation"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cmp-tabs" role="tablist">
          <Tab id="dm" mode={mode} setMode={setMode} label="New Message" />
          <Tab id="room" mode={mode} setMode={setMode} label="New Room" />
          <Tab id="space" mode={mode} setMode={setMode} label="New Space" />
          <Tab id="join" mode={mode} setMode={setMode} label="Join" />
        </div>
        <div className="cmp-body">
          {mode === "dm" && <NewDmForm onClose={onClose} />}
          {mode === "room" && <NewRoomForm onClose={onClose} />}
          {mode === "space" && <NewSpaceForm onClose={onClose} />}
          {mode === "join" && <JoinForm onClose={onClose} />}
        </div>
      </div>
    </div>
  );
}

function Tab({
  id,
  mode,
  setMode,
  label,
}: {
  id: Mode;
  mode: Mode;
  setMode: (m: Mode) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={mode === id}
      className={`cmp-tab${mode === id ? " cmp-tab--active" : ""}`}
      onClick={() => setMode(id)}
    >
      {label}
    </button>
  );
}

// --- Debounced user search --------------------------------------------------

function useUserSearch() {
  const session = useSession();
  const [results, setResults] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const search = useCallback(
    (term: string) => {
      clearTimeout(timer.current);
      const q = term.trim();
      if (!q) {
        setResults([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      timer.current = setTimeout(async () => {
        let hits: UserProfile[] = [];
        try {
          const res = await session.client.searchUsers(q, 10n);
          hits = res.results;
        } catch {
          hits = [];
        }
        // Accept a raw @user:server the directory may not return.
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
  return { results, loading, search };
}

// --- New DM -----------------------------------------------------------------

function NewDmForm({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const session = useSession();
  const { results, loading, search } = useUserSearch();
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState(false);

  const start = async (userId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const roomId = await startDirectMessage(session, userId);
      app.selectRoom(roomId);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        className="cmp-input"
        autoFocus
        placeholder="Search people or @user:server…"
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          search(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results.length > 0 && !busy) {
            e.preventDefault();
            void start(results[0].userId);
          }
        }}
      />
      <div className="cmp-results" role="listbox">
        {loading && <div className="cmp-hint">Searching…</div>}
        {!loading && term && results.length === 0 && (
          <div className="cmp-hint">No people found</div>
        )}
        {results.map((u) => (
          <button
            type="button"
            key={u.userId}
            className="cmp-user"
            role="option"
            disabled={busy}
            onClick={() => start(u.userId)}
          >
            <RoomAvatar name={u.displayName || u.userId} avatarUrl={u.avatarUrl} />
            <span className="cmp-user-text">
              <span className="cmp-user-name">{u.displayName || u.userId}</span>
              {u.displayName && <span className="cmp-user-sub">{u.userId}</span>}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

// --- New Room ---------------------------------------------------------------

function NewRoomForm({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const session = useSession();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("private");
  const [encrypted, setEncrypted] = useState(true);
  const [video, setVideo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const parentSpaceId = app.state.selectedSpaceId ?? undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const input = { name, topic, isEncrypted: encrypted, visibility, parentSpaceId };
      const roomId = video ? await createVideoRoom(session, input) : await createRoom(session, input);
      if (roomId) app.selectRoom(roomId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create room");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <input
        className="cmp-input"
        autoFocus
        placeholder="Room name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="cmp-input"
        placeholder="Topic (optional)"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
      />
      <label className="cmp-field">
        <span>Visibility</span>
        <select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as "public" | "private")}
        >
          <option value="private">Private (invite only)</option>
          <option value="public">Public (anyone can join)</option>
        </select>
      </label>
      <label className="cmp-check">
        <input type="checkbox" checked={encrypted} onChange={(e) => setEncrypted(e.target.checked)} />
        <span>Enable encryption</span>
      </label>
      <label className="cmp-check">
        <input type="checkbox" checked={video} onChange={(e) => setVideo(e.target.checked)} />
        <span>Video room (Element Call)</span>
      </label>
      {parentSpaceId && <div className="cmp-hint">Added to the current space.</div>}
      {error && <div className="cmp-error">{error}</div>}
      <div className="cmp-actions">
        <button type="button" className="cmp-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="cmp-btn cmp-btn--primary" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create room"}
        </button>
      </div>
    </form>
  );
}

// --- New Space --------------------------------------------------------------

function NewSpaceForm({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const session = useSession();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const spaceId = await createSpace(session, { name, topic, visibility });
      if (spaceId) {
        app.selectSpace(spaceId);
        onClose();
      } else {
        setError("Could not create space");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create space");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <input
        className="cmp-input"
        autoFocus
        placeholder="Space name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="cmp-input"
        placeholder="Description (optional)"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
      />
      <label className="cmp-field">
        <span>Visibility</span>
        <select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as "public" | "private")}
        >
          <option value="private">Private</option>
          <option value="public">Public</option>
        </select>
      </label>
      {error && <div className="cmp-error">{error}</div>}
      <div className="cmp-actions">
        <button type="button" className="cmp-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="cmp-btn cmp-btn--primary" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create space"}
        </button>
      </div>
    </form>
  );
}

// --- Join by address --------------------------------------------------------

function JoinForm({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const session = useSession();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const addr = address.trim();
    if (busy || !addr) return;
    setBusy(true);
    setError(undefined);
    try {
      const roomId = await joinByAddress(session, addr);
      app.selectRoom(roomId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join. Check the address.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <input
        className="cmp-input"
        autoFocus
        placeholder="#room:server.org  or  !roomid:server.org"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
      />
      {error && <div className="cmp-error">{error}</div>}
      <div className="cmp-actions">
        <button type="button" className="cmp-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="cmp-btn cmp-btn--primary" disabled={busy || !address.trim()}>
          {busy ? "Joining…" : "Join room"}
        </button>
      </div>
    </form>
  );
}
