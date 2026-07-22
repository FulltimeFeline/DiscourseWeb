// In-room message search (Cmd+F): a pure client-side scan over the room's
// loaded timeline, newest-first, with progressive back-pagination to search
// further history. No SDK search dependency.

import { useEffect, useMemo, useRef, useState } from "react";
import { useViewModel } from "@/core/reactive";
import type { EventEntry } from "@/models/types";
import type { TimelineViewModel } from "./TimelineViewModel";
import { Icon } from "@/ui/Icon";

type Category = "all" | "text" | "image" | "video" | "audio" | "file";

const CATEGORIES: { key: Category; label: string }[] = [
  { key: "all", label: "All" },
  { key: "text", label: "Text" },
  { key: "image", label: "Images" },
  { key: "video", label: "Video" },
  { key: "audio", label: "Audio" },
  { key: "file", label: "Files" },
];

/** Text we can match against for an event: sender name, body, media caption,
 *  and poll question, so a message is findable by who sent it or by a caption. */
function haystack(e: EventEntry): string {
  const c = e.content;
  const parts: string[] = [e.senderProfile.displayName ?? e.sender];
  if ("body" in c && c.body) parts.push(c.body);
  if ("caption" in c && c.caption) parts.push(c.caption);
  if (c.type === "poll") parts.push(c.question);
  return parts.join(" ");
}

function categoryOf(e: EventEntry): Category {
  switch (e.content.type) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "file":
      return "file";
    default:
      return "text";
  }
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function RoomSearchSheet({
  vm,
  onJump,
  onClose,
}: {
  vm: TimelineViewModel;
  onJump: (eventId: string) => void;
  onClose: () => void;
}) {
  const state = useViewModel(vm);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [scanning, setScanning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const q = query.trim().toLowerCase();

  const results = useMemo(() => {
    const out: EventEntry[] = [];
    // Newest-first over loaded events.
    for (let i = state.entries.length - 1; i >= 0; i--) {
      const e = state.entries[i];
      if (e.kind !== "event") continue;
      if (category !== "all" && categoryOf(e) !== category) continue;
      if (q && !haystack(e).toLowerCase().includes(q)) continue;
      if (!q && category === "all") continue; // no filter, so show nothing
      out.push(e);
      if (out.length >= 200) break;
    }
    return out;
  }, [state.entries, q, category]);

  // Progressive scan of older history: paginate until we hit the start or a cap.
  const loadOlder = async () => {
    if (scanning || state.reachedStart) return;
    setScanning(true);
    try {
      for (let i = 0; i < 8; i++) {
        if (vm.state.reachedStart) break;
        await vm.paginateBackwards();
      }
    } finally {
      setScanning(false);
    }
  };

  const oldest = state.entries.find((e) => e.kind === "event") as EventEntry | undefined;
  const coverage = state.reachedStart
    ? "Searched the whole conversation"
    : oldest
      ? `Searched back to ${fmtTime(oldest.timestamp)}`
      : "";

  return (
    <div className="roomsearch-scrim" onClick={onClose}>
      <div
        className="roomsearch"
        role="dialog"
        aria-label="Search in conversation"
        onClick={(e) => e.stopPropagation()}
      >
      <div className="roomsearch__head">
        <Icon name="search" />
        <input
          ref={inputRef}
          className="roomsearch__input"
          placeholder="Search in conversation"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onClose()}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <button className="roomsearch__close" onClick={onClose} aria-label="Close search">
          <Icon name="x" />
        </button>
      </div>

      <div className="roomsearch__cats">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            className={`roomsearch__cat${category === c.key ? " roomsearch__cat--on" : ""}`}
            onClick={() => setCategory(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="roomsearch__results">
        {results.length === 0 ? (
          <div className="roomsearch__empty">
            {q || category !== "all" ? "No matches in the loaded history." : "Type to search this conversation."}
          </div>
        ) : (
          results.map((e) => (
            <button
              key={e.id}
              className="roomsearch__result"
              onClick={() => {
                if (e.eventId) onJump(e.eventId);
                onClose();
              }}
            >
              <span className="roomsearch__result-top">
                <span className="roomsearch__result-name">
                  {e.senderProfile.displayName ?? e.sender}
                </span>
                <span className="roomsearch__result-time">{fmtTime(e.timestamp)}</span>
              </span>
              <span className="roomsearch__result-body">{haystack(e) || "(attachment)"}</span>
            </button>
          ))
        )}
      </div>

      <div className="roomsearch__foot">
        <span>
          {results.length} result{results.length === 1 ? "" : "s"} · {coverage}
        </span>
        {!state.reachedStart && (
          <button className="roomsearch__more" onClick={() => void loadOlder()} disabled={scanning}>
            {scanning ? "Searching older…" : "Search older messages"}
          </button>
        )}
      </div>
      </div>
    </div>
  );
}
