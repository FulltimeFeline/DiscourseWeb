// The ⌘K command palette. A modal overlay with a fuzzy-filtered list of rooms;
// ↑/↓ to move, Enter to open, Esc to close. Rendered by MainShell only when
// `app.isQuickSwitcherOpen`. Feed it a shared RoomIndex (see RoomIndex.ts).

import { useEffect, useMemo, useRef } from "react";
import { useViewModel } from "@/core/reactive";
import { useApp } from "@/app/context";
import { RoomAvatar } from "@/features/quickswitcher/RoomAvatar";
import { QuickSwitcherViewModel } from "./QuickSwitcherViewModel";
import type { RoomIndex } from "./RoomIndex";
import "./quickswitcher.css";

export function QuickSwitcher({ index }: { index: RoomIndex }) {
  const app = useApp();
  const vm = useMemo(() => new QuickSwitcherViewModel(app, index), [app, index]);
  useEffect(() => () => vm.dispose(), [vm]);

  const s = useViewModel(vm);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the active row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [s.activeIndex]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        vm.moveBy(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        vm.moveBy(-1);
        break;
      case "Enter":
        e.preventDefault();
        vm.confirm();
        break;
      case "Escape":
        e.preventDefault();
        vm.close();
        break;
      default:
        break;
    }
  };

  return (
    <div className="qs-scrim" onMouseDown={() => vm.close()} role="presentation">
      <div
        className="qs-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Jump to a room"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="qs-input"
          type="text"
          placeholder="Jump to a room…"
          value={s.query}
          onChange={(e) => vm.setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="qs-results"
          aria-activedescendant={s.results[s.activeIndex] ? `qs-row-${s.activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <div id="qs-results" className="qs-results" ref={listRef} role="listbox">
          {s.results.length === 0 ? (
            <div className="qs-empty">No rooms found</div>
          ) : (
            s.results.map((r, i) => (
              <div
                key={r.id}
                id={`qs-row-${i}`}
                className="qs-row"
                role="option"
                aria-selected={i === s.activeIndex}
                data-active={i === s.activeIndex}
                onMouseEnter={() => vm.setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  vm.confirm(i);
                }}
              >
                <RoomAvatar name={r.name} avatarUrl={r.avatarUrl} />
                <div className="qs-row-text">
                  <div className="qs-row-name">{r.name}</div>
                  {r.canonicalAlias && <div className="qs-row-sub">{r.canonicalAlias}</div>}
                </div>
                {r.isDirect && <span className="qs-badge">DM</span>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
