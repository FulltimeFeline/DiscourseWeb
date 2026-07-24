// A small local context-menu primitive for the room list + spaces rail.
//
// Deliberately self-contained (no cross-feature import): a fixed-position menu
// of <Icon>+label rows, opened at the cursor via onContextMenu, dismissed on
// outside-click, Esc, scroll, or window blur. Danger rows (Leave) get the
// mention/red tint. Rows may carry a `confirm` string; the first click swaps the
// label to the confirmation and a second click commits (inline confirm, no
// window.confirm modal-blocking).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "@/ui/Icon";
import "./roomlist.css";

export interface MenuItem {
  key: string;
  label: string;
  icon: IconName;
  danger?: boolean;
  /** When set, the row asks for a second click showing this label first. */
  confirm?: string;
  onSelect: () => void;
}

export interface MenuAnchor {
  x: number;
  y: number;
}

export function RoomMenu({
  anchor,
  items,
  onClose,
}: {
  anchor: MenuAnchor;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: anchor.x,
    top: anchor.y,
  });
  const [confirming, setConfirming] = useState<string | null>(null);

  // Flip the menu so it stays inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let left = anchor.x;
    let top = anchor.y;
    if (left + rect.width + pad > window.innerWidth) {
      left = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (top + rect.height + pad > window.innerHeight) {
      top = Math.max(pad, anchor.y - rect.height);
    }
    setPos({ left, top });
  }, [anchor.x, anchor.y]);

  // Dismiss on outside interaction.
  useEffect(() => {
    const close = () => onCloseRef.current();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    // Capture-phase pointerdown so a right-click elsewhere closes then reopens.
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("contextmenu", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("contextmenu", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
    };
  }, []);

  const activate = (item: MenuItem) => {
    if (item.confirm && confirming !== item.key) {
      setConfirming(item.key);
      return;
    }
    onClose();
    item.onSelect();
  };

  return createPortal(
    <div
      ref={ref}
      className="rl-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => {
        const asking = item.confirm != null && confirming === item.key;
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={`rl-menu__item${item.danger || asking ? " rl-menu__item--danger" : ""}`}
            onClick={() => activate(item)}
          >
            <span className="rl-menu__icon" aria-hidden>
              <Icon name={asking ? "warning" : item.icon} size={16} />
            </span>
            <span className="rl-menu__label">{asking ? item.confirm : item.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
