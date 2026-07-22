// The rail's account button: your avatar plus a gear badge. Clicking opens an
// account menu (switch account, add account, settings, sign out).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useViewModel } from "@/core/reactive";
import { useApp } from "@/app/context";
import { modals } from "./ModalManager";
import { Icon } from "@/ui/Icon";
import { RoomAvatar } from "@/features/roomlist/RoomAvatar";
import "./settings.css";

export function SettingsButton() {
  const app = useApp();
  const snap = useViewModel(app);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The menu is portaled to <body>, so it's outside `ref`; check it too.
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="dm-acct" ref={ref}>
      {open &&
        createPortal(
          <div className="dm-acct__menu" role="menu" ref={menuRef}>
          {snap.accounts.map((a) => (
            <button
              key={a.userId}
              className={`dm-acct__row${a.userId === snap.activeUserId ? " dm-acct__row--active" : ""}`}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void app.switchAccount(a.userId);
              }}
            >
              <RoomAvatar name={a.displayName ?? a.userId} avatarUrl={a.avatarUrl} size={26} />
              <span className="dm-acct__name">{a.displayName ?? a.userId}</span>
              {a.userId === snap.activeUserId && <Icon name="check" size={15} />}
            </button>
          ))}
          <div className="dm-acct__sep" />
          <button
            className="dm-acct__item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              app.setAddAccountOpen(true);
            }}
          >
            <Icon name="plus" size={16} /> Add account
          </button>
          <button
            className="dm-acct__item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              modals.openSettings("account");
            }}
          >
            <Icon name="gear" size={16} /> Settings
          </button>
          <button
            className="dm-acct__item dm-acct__item--danger"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void app.logOut();
            }}
          >
            <Icon name="x" size={16} /> Sign out
          </button>
          </div>,
          document.body,
        )}
      <button
        className="dm-settings-btn"
        aria-label="Settings & account"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="gear" size={22} />
      </button>
    </div>
  );
}
