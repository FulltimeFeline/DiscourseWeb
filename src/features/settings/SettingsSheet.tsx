// The settings modal: a tab sidebar plus a scrolling detail pane. Opened via
// the ModalManager (`modals.openSettings()`).

import { useState, type ReactNode } from "react";
import { Icon } from "@/ui/Icon";
import type { SettingsTab } from "./ModalManager";
import { AccountTab } from "./AccountTab";
import { useModalBehavior } from "./primitives";
import { StickerMaker } from "./StickerMaker";
import {
  AppearanceTab,
  ChatTab,
  PrivacyTab,
  NotificationsTab,
  AccessibilityTab,
  StorageTab,
  AdvancedTab,
  AboutTab,
  AccountsTab,
} from "./SettingsTabs";
import "./settings.css";

const TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: "account", label: "Account", icon: <Icon name="people" /> },
  { id: "accounts", label: "Accounts", icon: <Icon name="people" /> },
  { id: "appearance", label: "Appearance", icon: <Icon name="star" /> },
  { id: "chat", label: "Chat", icon: <Icon name="envelope" /> },
  { id: "privacy", label: "Privacy", icon: <Icon name="lock" /> },
  { id: "notifications", label: "Notifications", icon: <Icon name="bell" /> },
  { id: "accessibility", label: "Accessibility", icon: <Icon name="info" /> },
  { id: "stickers", label: "Stickers", icon: <Icon name="smile" /> },
  { id: "storage", label: "Storage", icon: <Icon name="file" /> },
  { id: "advanced", label: "Advanced", icon: <Icon name="gear" /> },
  { id: "about", label: "About", icon: <Icon name="info" /> },
];

export function SettingsSheet({ initialTab, onClose }: { initialTab: SettingsTab; onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const ref = useModalBehavior(onClose);

  return (
    <div className="dm-scrim" onMouseDown={onClose}>
      <div ref={ref} tabIndex={-1} className="dm-settings" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="dm-settings__tabs" role="tablist" aria-label="Settings sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === tab}
              className={`dm-tab${t.id === tab ? " dm-tab--on" : ""}`}
              onClick={() => setTab(t.id)}
            >
              <span className="dm-tab__icon">{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="dm-settings__detail">
          <header className="dm-settings__head">
            <h2>{TABS.find((t) => t.id === tab)?.label}</h2>
            <button className="dm-iconbtn" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button>
          </header>
          <div className="dm-settings__scroll">
            {tab === "account" && <AccountTab />}
            {tab === "accounts" && <AccountsTab />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "chat" && <ChatTab />}
            {tab === "privacy" && <PrivacyTab />}
            {tab === "notifications" && <NotificationsTab />}
            {tab === "accessibility" && <AccessibilityTab />}
            {tab === "stickers" && <StickerMaker />}
            {tab === "storage" && <StorageTab />}
            {tab === "advanced" && <AdvancedTab />}
            {tab === "about" && <AboutTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
