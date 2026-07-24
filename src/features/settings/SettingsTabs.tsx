// The non-account settings tabs. Each reads/writes the shared `preferences`
// store (core/Preferences.ts) or the supplementary `settingsPrefs` store for
// the keys the shared store lacks. Appearance changes flow through
// preferences.patch, which already drives the CSS variables.

import { useEffect, useState } from "react";
import { useApp, useSession } from "@/app/context";
import { useStore, useViewModel } from "@/core/reactive";
import { preferences } from "@/core/Preferences";
import { RoomNotificationMode, type NotificationSettingsInterface } from "@/matrix";
import { settingsPrefs } from "./settingsPrefs";
import { ACCENTS, DEFAULT_ACCENT, SYSTEM_ACCENT, systemAccentSupported } from "./accents";
import { Section, Row, Toggle, Segmented, Button } from "./primitives";
import { useMediaUrl } from "./useMediaUrl";
import { Icon } from "@/ui/Icon";

// --- Appearance -------------------------------------------------------------

export function AppearanceTab() {
  const p = useStore(preferences);
  const sp = useStore(settingsPrefs);
  return (
    <>
      <Section title="Appearance">
        <Row
          label="Accent Color"
          control={
            <div className="dm-swatches">
              {ACCENTS.filter((a) => a.hex !== SYSTEM_ACCENT || systemAccentSupported).map((a) => {
                const value = a.hex ?? DEFAULT_ACCENT;
                const active = value === p.accent;
                return (
                  <button
                    key={a.id}
                    title={a.label}
                    className={`dm-swatch${active ? " dm-swatch--on" : ""}`}
                    // The System swatch shows the live OS accent.
                    style={{ background: a.hex === SYSTEM_ACCENT ? "AccentColor" : value }}
                    onClick={() => preferences.patch({ accent: value })}
                  />
                );
              })}
            </div>
          }
        />
        <Row
          label="Tinted window"
          hint="Washes the window background with the accent color; off keeps the plain gray."
          control={
            <Toggle
              checked={p.tintedWindow}
              onChange={(v) => preferences.patch({ tintedWindow: v })}
            />
          }
        />
      </Section>
      <Section title="Timeline">
        <Row
          label="Message Density"
          control={
            <Segmented
              value={p.messageDensity}
              onChange={(messageDensity) => preferences.patch({ messageDensity })}
              options={[
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ]}
            />
          }
        />
        <Row
          label="Chat Text Size"
          hint={`${Math.round(p.fontScale * 100)}%`}
          control={
            <input
              type="range"
              min={0.8}
              max={1.4}
              step={0.05}
              value={p.fontScale}
              onChange={(e) => preferences.patch({ fontScale: Number(e.target.value) })}
            />
          }
        />
        <p className="dm-preview" style={{ fontSize: `calc(17px * ${p.fontScale})` }}>
          The quick brown fox jumps over the lazy dog.
        </p>
        <Row label="Show avatars in timeline" control={<Toggle checked={sp.showAvatarsInTimeline} onChange={(v) => settingsPrefs.patch({ showAvatarsInTimeline: v })} />} />
        <Row label="Colored sender names" control={<Toggle checked={sp.coloredSenderNames} onChange={(v) => settingsPrefs.patch({ coloredSenderNames: v })} />} />
      </Section>
    </>
  );
}

// --- Chat -------------------------------------------------------------------

export function ChatTab() {
  const p = useStore(preferences);
  const sp = useStore(settingsPrefs);
  return (
    <Section title="Chat">
      <Row label="Jumbo emoji" control={<Toggle checked={p.jumboEmoji} onChange={(v) => preferences.patch({ jumboEmoji: v })} />} />
      <Row label="24-hour time" control={<Toggle checked={sp.use24HourTime} onChange={(v) => settingsPrefs.patch({ use24HourTime: v })} />} />
      <Row label="Always show timestamps" control={<Toggle checked={sp.alwaysShowTimestamps} onChange={(v) => settingsPrefs.patch({ alwaysShowTimestamps: v })} />} />
      <Row label="Show read receipts" control={<Toggle checked={sp.showReadReceipts} onChange={(v) => settingsPrefs.patch({ showReadReceipts: v })} />} />
    </Section>
  );
}

// --- Privacy ----------------------------------------------------------------

export function PrivacyTab() {
  const p = useStore(preferences);
  const sp = useStore(settingsPrefs);
  return (
    <Section title="Privacy" footnote="Each toggle changes what your client sends to the homeserver.">
      <Row label="Send read receipts" control={<Toggle checked={p.sendReadReceipts} onChange={(v) => preferences.patch({ sendReadReceipts: v })} />} />
      <Row label="Send typing notifications" control={<Toggle checked={p.sendTypingNotifications} onChange={(v) => preferences.patch({ sendTypingNotifications: v })} />} />
      <Row label="Share presence" control={<Toggle checked={p.sendPresence} onChange={(v) => preferences.patch({ sendPresence: v })} />} />
      <Row label="Warn in unencrypted rooms" control={<Toggle checked={sp.warnUnencrypted} onChange={(v) => settingsPrefs.patch({ warnUnencrypted: v })} />} />
      <Row label="Remove location from photos" control={<Toggle checked={sp.stripLocationMetadata} onChange={(v) => settingsPrefs.patch({ stripLocationMetadata: v })} />} />
    </Section>
  );
}

// --- Notifications ----------------------------------------------------------

export function NotificationsTab() {
  const session = useSession();
  const sp = useStore(settingsPrefs);
  const [settings, setSettings] = useState<NotificationSettingsInterface | null>(null);
  const [defaultMode, setDefaultMode] = useState<RoomNotificationMode | null>(null);

  useEffect(() => {
    let alive = true;
    void session.client.getNotificationSettings().then(async (s) => {
      if (!alive) return;
      setSettings(s);
      try {
        // Default room mode for group (encrypted) rooms as a representative value.
        const mode = await s.getDefaultRoomNotificationMode(true, false);
        if (alive) setDefaultMode(mode);
      } catch {
        /* leave null */
      }
    });
    return () => {
      alive = false;
    };
  }, [session]);

  return (
    <>
      <Section title="Notifications" footnote="How message notifications are presented on this device.">
        <Row
          label="Show in Notifications"
          control={
            <Segmented
              value={sp.notificationPreview}
              onChange={(notificationPreview) => settingsPrefs.patch({ notificationPreview })}
              options={[
                { value: "full", label: "Sender & Message" },
                { value: "senderOnly", label: "Sender Only" },
                { value: "none", label: "Nothing" },
              ]}
            />
          }
        />
        <Row label="Play sound" control={<Toggle checked={sp.notificationSound} onChange={(v) => settingsPrefs.patch({ notificationSound: v })} />} />
      </Section>
      <Section title="Default Room Notifications" footnote="The default push rule applied to new rooms. Per-room overrides live in each room's settings.">
        <Row
          label="New rooms notify for"
          control={
            <Segmented
              value={defaultMode === RoomNotificationMode.Mute ? "mute" : defaultMode === RoomNotificationMode.MentionsAndKeywordsOnly ? "mentions" : "all"}
              onChange={async (v) => {
                if (!settings) return;
                // Default mode is derived server-side and surfaced read-mostly.
                // This SDK build exposes no default-mode setter, so reflect the
                // choice locally just for display.
                setDefaultMode(v === "mute" ? RoomNotificationMode.Mute : v === "mentions" ? RoomNotificationMode.MentionsAndKeywordsOnly : RoomNotificationMode.AllMessages);
              }}
              options={[
                { value: "all", label: "All messages" },
                { value: "mentions", label: "Mentions only" },
                { value: "mute", label: "Off" },
              ]}
            />
          }
        />
      </Section>
    </>
  );
}

// --- Accessibility ----------------------------------------------------------

export function AccessibilityTab() {
  const p = useStore(preferences);
  const sp = useStore(settingsPrefs);
  return (
    <Section title="Accessibility">
      <Row label="Reduce motion" hint="Also honours your system setting." control={<Toggle checked={sp.reduceTimelineMotion} onChange={(v) => settingsPrefs.patch({ reduceTimelineMotion: v })} />} />
      <Row label="Larger tap targets" control={<Toggle checked={sp.largerTapTargets} onChange={(v) => settingsPrefs.patch({ largerTapTargets: v })} />} />
      <Row label="Confirm before deleting messages" control={<Toggle checked={sp.confirmBeforeDeleting} onChange={(v) => settingsPrefs.patch({ confirmBeforeDeleting: v })} />} />
      <Row label="Return key sends message" control={<Toggle checked={p.sendOnEnter} onChange={(v) => preferences.patch({ sendOnEnter: v })} />} />
    </Section>
  );
}

// --- Storage ----------------------------------------------------------------

export function StorageTab() {
  const sp = useStore(settingsPrefs);
  const [usage, setUsage] = useState<number | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [clearing, setClearing] = useState(false);

  async function measure() {
    setMeasuring(true);
    try {
      const est = await navigator.storage?.estimate?.();
      setUsage(est?.usage ?? 0);
    } catch {
      setUsage(0);
    } finally {
      setMeasuring(false);
    }
  }

  useEffect(() => {
    void measure();
  }, []);

  async function clearCache() {
    setClearing(true);
    try {
      // Purge the browser Cache Storage (media object cache lives in SDK IndexedDB;
      // we only clear what's safe to drop without touching the crypto store).
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      setTimeout(() => void measure(), 300);
    } finally {
      setClearing(false);
    }
  }

  return (
    <Section title="Storage">
      <Row label="Auto-download images" control={<Toggle checked={sp.autoDownloadImages} onChange={(v) => settingsPrefs.patch({ autoDownloadImages: v })} />} />
      <Row
        label="Cache Used"
        control={<span className="dm-mono">{measuring || usage === null ? "Measuring…" : formatBytes(usage)}</span>}
      />
      <Button variant="destructive" busy={clearing} disabled={usage === 0} onClick={clearCache}>
        Clear Cache
      </Button>
    </Section>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// --- Advanced ---------------------------------------------------------------

export function AdvancedTab() {
  const session = useSession();
  const sp = useStore(settingsPrefs);
  const ffi = session.session();
  return (
    <>
      <Section title="Session">
        <InfoRow label="User ID" value={session.userId} />
        <InfoRow label="Homeserver" value={ffi?.homeserverUrl ?? "—"} />
        <InfoRow label="Device ID" value={ffi?.deviceId ?? "—"} />
      </Section>
      <Section title="Developer">
        <Row label="Show event IDs" control={<Toggle checked={sp.showEventIds} onChange={(v) => settingsPrefs.patch({ showEventIds: v })} />} />
      </Section>
      <Section footnote="Restores every preference to its default. Your account and messages are untouched.">
        <Button
          variant="destructive"
          onClick={() => {
            if (confirm("Reset all settings to defaults?")) {
              settingsPrefs.resetToDefaults();
              // Reset the shared appearance/behaviour store too.
              preferences.patch({
                theme: "system",
                accent: DEFAULT_ACCENT,
                tintedWindow: true,
                messageDensity: "comfortable",
                fontScale: 1,
                sendOnEnter: true,
                jumboEmoji: true,
                sendReadReceipts: true,
                sendTypingNotifications: true,
                sendPresence: true,
              });
            }
          }}
        >
          Reset All Settings
        </Button>
      </Section>
    </>
  );
}

// --- About ------------------------------------------------------------------

export function AboutTab() {
  return (
    <Section>
      <div className="dm-about">
        <div className="dm-about__icon"><Icon name="envelope" /></div>
        <h3>Discourse</h3>
        <p>A Matrix client</p>
        <p className="dm-about__by">by FulltimeFeline</p>
        <div className="dm-about__links">
          <a href="https://github.com/FulltimeFeline/DiscourseWeb" target="_blank" rel="noreferrer">Source on GitHub</a>
          <a href="https://matrix.org" target="_blank" rel="noreferrer">matrix.org</a>
          <a href="https://spec.matrix.org" target="_blank" rel="noreferrer">spec.matrix.org</a>
        </div>
      </div>
    </Section>
  );
}

// --- Accounts ---------------------------------------------------------------

export function AccountsTab() {
  const app = useApp();
  const s = useViewModel(app);
  return (
    <Section title="Accounts">
      {s.accounts.map((a) => (
        <button
          key={a.userId}
          className={`dm-account-row${a.userId === s.activeUserId ? " dm-account-row--active" : ""}`}
          onClick={() => void app.switchAccount(a.userId)}
        >
          <AccountAvatar userId={a.userId} avatarUrl={a.avatarUrl} />
          <div className="dm-account-row__meta">
            <span className="dm-account-row__name">{a.displayName ?? a.userId}</span>
            <span className="dm-account-row__id">{a.userId}</span>
          </div>
          {a.userId === s.activeUserId && <span className="dm-check"><Icon name="check" size={16} /></span>}
        </button>
      ))}
      <Button onClick={() => app.setAddAccountOpen(true)}>Add Account…</Button>
    </Section>
  );
}

function AccountAvatar({ userId, avatarUrl }: { userId: string; avatarUrl?: string }) {
  const url = useMediaUrl(avatarUrl, { thumb: 56 });
  return (
    <span className="dm-account-row__avatar" style={url ? { backgroundImage: `url(${url})` } : undefined}>
      {!url && userId.replace(/^@/, "").slice(0, 1).toUpperCase()}
    </span>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="dm-info">
      <span className="dm-info__label">{label}</span>
      <span className="dm-info__value">{value}</span>
    </div>
  );
}
