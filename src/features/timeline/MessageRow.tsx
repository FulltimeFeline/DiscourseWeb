import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  AudioContent,
  EventEntry,
  ImageContent,
  MediaRef,
  ReplyPreview,
  StickerContent,
  VideoContent,
} from "@/models/types";
import { preferences } from "@/core/Preferences";
import { colorFor } from "@/core/palette";
import { useStore } from "@/core/reactive";
import { clampMediaSize } from "@/core/blurhash";
import { useSession } from "@/app/context";
import type { TimelineViewModel, WithHeader } from "./TimelineViewModel";
import { useBlurhash, useMedia } from "./useMedia";
import { Lightbox } from "@/features/media/Lightbox";
import { Icon } from "@/ui/Icon";
import { EmoteText } from "@/features/emotes";
import { ReactionChips, ReactionPalette } from "@/features/pickers";
import { VoiceMessagePlayer } from "@/features/media";
import { saveMedia, copyImage } from "@/features/media/mediaActions";
import type { CustomEmojiStore } from "@/core/CustomEmojiStore";
import { usePronouns } from "@/core/PronounsService";
import { useCustomEmoji } from "@/features/emotes/emojiSession";
import { RoomAvatar } from "@/features/roomlist/RoomAvatar";
import { useMemberProfile } from "@/features/details/memberProfiles";
import { modals } from "@/features/settings/ModalManager";
import {
  formatDuration,
  formatHeaderTime,
  formatShortTime,
  formatSize,
  isJumboEmoji,
  renderMarkdown,
} from "./render";

interface Props {
  entry: EventEntry;
  vm: TimelineViewModel;
  ownUserId: string;
  onReply: (entry: EventEntry) => void;
  onEdit: (entry: EventEntry) => void;
  onOpenThread: (rootEventId: string) => void;
  onJumpToEvent: (eventId: string) => void;
}

export const MessageRow = memo(function MessageRow(props: Props) {
  const { entry, vm, ownUserId } = props;
  const prefs = useStore(preferences);
  const session = useSession();
  const customEmoji = useCustomEmoji(session);
  const pronouns = usePronouns(session, entry.sender);
  const showsHeader = (entry as WithHeader).showsHeader !== false;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // Lazy shield fetch on first appearance.
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          vm.loadShieldIfNeeded(entry.id);
          obs.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [entry.id, vm]);

  const isSystem =
    entry.content.type === "membership" ||
    entry.content.type === "state" ||
    entry.content.type === "call";

  if (isSystem) {
    const summary =
      "summary" in entry.content ? entry.content.summary : "";
    return (
      <div className="system-row">
        <span className="system-row__gutter">›</span>
        <span>{summary}</span>
      </div>
    );
  }

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  // "More" button opens the same menu as right-click, anchored to the button.
  const openMenuFromButton = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: rect.right - 4, y: rect.bottom + 4 });
  };

  const isText = entry.content.type === "text";
  const canEdit = entry.isOwn && entry.eventId != null && isText;

  return (
    <div
      ref={rowRef}
      className={`msg-row${showsHeader ? "" : " msg-row--grouped"}${
        entry.sendState?.type === "sending" ? " msg-row--sending" : ""
      }`}
      onContextMenu={openMenu}
    >
      <div className="msg-gutter">
        {showsHeader ? (
          <Avatar entry={entry} vm={vm} />
        ) : (
          <span
            className={`msg-gutter__time${prefs.messageDensity === "compact" ? " msg-gutter__time--always" : ""}`}
          >
            {formatShortTime(entry.timestamp)}
          </span>
        )}
      </div>
      <div className="msg-body">
        {showsHeader && (
          <div className="msg-header">
            <span
              className="msg-sender"
              onClick={() => modals.openProfile(entry.sender)}
              title={entry.sender}
              style={prefs.coloredSenderNames ? { color: colorFor(entry.sender) } : undefined}
            >
              {entry.senderProfile.displayName ?? localpart(entry.sender)}
            </span>
            {pronouns && <span className="msg-pronouns">{pronouns}</span>}
            <span className="msg-time">{formatHeaderTime(entry.timestamp)}</span>
          </div>
        )}
        {entry.inReplyTo && (
          <ReplyPreviewView reply={entry.inReplyTo} onJump={props.onJumpToEvent} />
        )}
        {entry.shield ? (
          // Authenticity indicator sits inline, to the left of the message
          // content, not as a badge next to the name.
          <div className="msg-shielded">
            <ShieldBadge shield={entry.shield} />
            <MessageContentView entry={entry} customEmoji={customEmoji} vm={vm} ownUserId={ownUserId} />
          </div>
        ) : (
          <MessageContentView entry={entry} customEmoji={customEmoji} vm={vm} ownUserId={ownUserId} />
        )}
        {entry.sendState?.type === "failed" && (
          <div className="msg-send-failed" title={entry.sendState.error}>
            <Icon name="warning" size={13} /> Failed to send
            <button className="msg-send-failed__action" onClick={() => vm.retrySend()}>
              Retry
            </button>
            <button
              className="msg-send-failed__action"
              onClick={() => void vm.redactEvent(entry)}
            >
              Remove
            </button>
          </div>
        )}
        {prefs.renderReactions && entry.reactions.length > 0 && (
          <ReactionChips
            reactions={entry.reactions}
            customEmoji={customEmoji}
            onToggle={(key) => void vm.toggleReaction(entry, key)}
            resolveName={(id) => vm.displayNameFor(id)}
          />
        )}
        {entry.threadSummary && entry.threadSummary.count > 0 && entry.eventId && (
          <button className="thread-button" onClick={() => props.onOpenThread(entry.eventId!)}>
            {entry.threadSummary.count} {entry.threadSummary.count === 1 ? "reply" : "replies"}
          </button>
        )}
        <ReceiptStack entry={entry} vm={vm} />
      </div>
      {menu && (
        <ContextMenu
          {...props}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
});

function Avatar({ entry, vm }: { entry: EventEntry; vm: TimelineViewModel }) {
  const session = useSession();
  const profile = useMemberProfile(session, vm.roomIdValue, entry.sender);
  // Prefer the room member's profile avatar; fall back to the event's cached
  // sender profile. RoomAvatar resolves the mxc and shows gradient initials when
  // there's no avatar url.
  const avatarUrl = profile?.avatarUrl ?? entry.senderProfile.avatarUrl ?? undefined;
  const name = entry.senderProfile.displayName ?? localpart(entry.sender);
  const openProfile = () => modals.openProfile(entry.sender);
  return (
    <span
      onClick={openProfile}
      title={entry.sender}
      style={{ display: "inline-flex", lineHeight: 0, cursor: "pointer" }}
    >
      <RoomAvatar name={name} avatarUrl={avatarUrl} size={40} />
    </span>
  );
}

function ShieldBadge({ shield }: { shield: NonNullable<EventEntry["shield"]> }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <span className="shield-wrap">
      <button
        type="button"
        className={`shield shield--${shield.color}`}
        title={shield.message}
        aria-label={shield.message}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon name="alert-circle" size={14} />
      </button>
      {open && <span className="shield-pop">{shield.message}</span>}
    </span>
  );
}

function MessageContentView({
  entry,
  customEmoji,
  vm,
  ownUserId,
}: {
  entry: EventEntry;
  customEmoji?: CustomEmojiStore;
  vm: TimelineViewModel;
  ownUserId: string;
}) {
  const session = useSession();
  const c = entry.content;
  switch (c.type) {
    case "text": {
      const jumbo = c.msgtype !== "notice" && isJumboEmoji(c.body);
      const displayBody =
        c.msgtype === "emote"
          ? `${entry.senderProfile.displayName ?? localpart(entry.sender)} ${c.body}`
          : c.body;
      // Custom emotes (MSC2545) can't be rendered by the sanitised markdown path
      // (mxc:// <img> won't load and data-mx-emoticon is stripped), so route
      // bodies carrying custom emotes through EmoteText, which resolves mxc via
      // the media loader. Plain and markdown bodies keep the existing HTML render.
      const hasCustomEmotes =
        !!customEmoji &&
        (/<img\b[^>]*\bsrc="mxc:\/\//i.test(c.html ?? "") ||
          customEmoji.knownEmotesIn(displayBody).size > 0);
      if (hasCustomEmotes) {
        return (
          <div className={`msg-text msg-text--${c.msgtype}${jumbo ? " msg-text--jumbo" : ""}`}>
            <EmoteText body={displayBody} html={c.html} customEmoji={customEmoji} />
            {entry.isEdited && <span className="msg-edited">(edited)</span>}
          </div>
        );
      }
      const html = c.html ?? renderMarkdown(displayBody);
      return (
        <div className={`msg-text msg-text--${c.msgtype}${jumbo ? " msg-text--jumbo" : ""}`}>
          <span dangerouslySetInnerHTML={{ __html: html }} />
          {entry.isEdited && <span className="msg-edited">(edited)</span>}
        </div>
      );
    }
    case "image":
      return <ImageView content={c} />;
    case "sticker":
      return <StickerView content={c} />;
    case "video":
      return <VideoView content={c} />;
    case "audio":
      return c.isVoice ? (
        <VoiceMessagePlayer
          itemId={entry.id}
          content={c}
          loader={session.mediaLoader}
          sessionId={session.userId}
        />
      ) : (
        <FileView
          content={{ body: c.body, source: c.source, mimetype: c.mimetype, size: c.size }}
          icon={<Icon name="music" />}
        />
      );
    case "file":
      return <FileView content={c} />;
    case "poll":
      return <PollView entry={entry} vm={vm} ownUserId={ownUserId} />;
    case "location":
      return (
        <a
          className="msg-chip"
          href={mapsUrl(c.geoUri)}
          target="_blank"
          rel="noreferrer"
        >
          <Icon name="pin" size={15} /> {c.body || "Location"}
        </a>
      );
    case "redacted":
      return <div className="msg-redacted">Message deleted</div>;
    case "encrypted":
      return (
        <div className="msg-encrypted">
          <Icon name="lock" /> {c.reason}
        </div>
      );
    case "unsupported":
    default:
      return <div className="msg-text msg-text--notice">{"body" in c ? c.body : "Unsupported message"}</div>;
  }
}

function ImageView({ content }: { content: ImageContent }) {
  const session = useSession();
  const size = clampMediaSize(content.width, content.height, { maxWidth: 360, maxHeight: 280, fallbackWidth: 280, fallbackHeight: 200 });
  const blur = useBlurhash(content.blurhash);
  const url = useMedia(content.thumbnail ?? content.source, { width: 480, height: 480 });
  const [zoom, setZoom] = useState(false);
  return (
    <>
      <div className="msg-media" style={{ width: size.width, height: size.height }}>
        <img
          className={`msg-media__img${url ? "" : " msg-media__blur"}`}
          src={url ?? blur}
          alt={content.body}
          style={{ width: size.width, height: size.height, backgroundImage: blur ? `url(${blur})` : undefined }}
          onClick={() => setZoom(true)}
        />
      </div>
      {content.caption && <div className="msg-caption">{content.caption}</div>}
      {zoom && (
        <Lightbox
          loader={session.mediaLoader}
          source={content.source}
          mimetype={content.mimetype}
          fallbackUrl={url}
          filename={content.body}
          onClose={() => setZoom(false)}
        />
      )}
    </>
  );
}

function StickerView({ content }: { content: StickerContent }) {
  const size = clampMediaSize(content.width, content.height, { maxWidth: 160, maxHeight: 160, fallbackWidth: 160, fallbackHeight: 160 });
  const url = useMedia(content.source, { width: 160, height: 160 });
  return (
    <div className="msg-media msg-media--sticker" style={{ width: size.width, height: size.height }}>
      {url && <img className="msg-media__img" src={url} alt={content.body} style={{ width: size.width, height: size.height }} />}
    </div>
  );
}

function VideoView({ content }: { content: VideoContent }) {
  const blur = useBlurhash(content.blurhash);
  const url = useMedia(content.source);
  const poster = useMedia(content.thumbnail, { width: 480, height: 480 });
  return (
    <div className="msg-video">
      {url ? (
        <video src={url} poster={poster} controls preload="none" />
      ) : (
        <div className="msg-media__img msg-media__blur" style={{ width: 320, height: 200, backgroundImage: blur ? `url(${blur})` : undefined, backgroundSize: "cover" }} />
      )}
      {content.duration != null && (
        <span className="msg-video__badge">{formatDuration(content.duration)}</span>
      )}
      {content.caption && <div className="msg-caption">{content.caption}</div>}
    </div>
  );
}


function FileView({
  content,
  icon = <Icon name="file" />,
}: {
  content: { body: string; source: MediaRef; mimetype?: string; size?: number };
  icon?: React.ReactNode;
}) {
  const session = useSession();
  const download = async () => {
    const u = await session.mediaLoader.load({ source: content.source, mxc: content.source.mxc, mimetype: content.mimetype });
    if (u) window.open(u, "_blank");
  };
  return (
    <button className="msg-file" onClick={() => void download()}>
      <span>{icon}</span>
      <span>{content.body}</span>
      {content.size != null && <span className="msg-file__meta">{formatSize(content.size)}</span>}
    </button>
  );
}

function PollView({
  entry,
  vm,
  ownUserId,
}: {
  entry: EventEntry;
  vm: TimelineViewModel;
  ownUserId: string;
}) {
  const c = entry.content;
  if (c.type !== "poll") return null;
  const startId = entry.eventId;
  const totalVotes = Object.values(c.votes).reduce((n, v) => n + v.length, 0);
  const ended = c.endTs != null && c.endTs <= Date.now();
  const hideResults = c.kind === "undisclosed" && !ended;
  const myVotes = new Set(
    Object.entries(c.votes)
      .filter(([, voters]) => voters.includes(ownUserId))
      .map(([id]) => id),
  );
  const votable = !ended && !!startId;
  return (
    <div className="poll" style={{ maxWidth: 360 }}>
      <div className="poll__q">{c.question}</div>
      {c.answers.map((a) => {
        const count = c.votes[a.id]?.length ?? 0;
        const pct = totalVotes ? Math.round((count / totalVotes) * 100) : 0;
        const mine = myVotes.has(a.id);
        return (
          <button
            key={a.id}
            type="button"
            className={`poll__opt${mine ? " poll__opt--mine" : ""}`}
            disabled={!votable}
            onClick={() => votable && void vm.votePoll(startId!, a.id)}
          >
            <span className="poll__opt-row">
              <span className="poll__opt-mark" aria-hidden>
                {mine ? <Icon name="check" size={13} /> : null}
              </span>
              <span className="poll__opt-text">{a.text}</span>
              {!hideResults && <span className="poll__opt-count">{count}</span>}
            </span>
            {!hideResults && (
              <span className="poll__bar">
                <span className="poll__bar-fill" style={{ width: `${pct}%` }} />
              </span>
            )}
          </button>
        );
      })}
      <div className="poll__foot">
        {ended ? "Final results · " : hideResults ? "Results hidden until the poll ends · " : ""}
        {totalVotes} vote{totalVotes === 1 ? "" : "s"}
        {entry.isOwn && !ended && startId && (
          <button className="poll__end" type="button" onClick={() => void vm.endPoll(startId)}>
            End poll
          </button>
        )}
      </div>
    </div>
  );
}

function ReplyPreviewView({ reply, onJump }: { reply: ReplyPreview; onJump: (id: string) => void }) {
  const body =
    reply.status === "ready"
      ? reply.body ?? "…"
      : reply.status === "pending"
        ? "…"
        : reply.status === "error"
          ? "Message unavailable"
          : "Message unavailable";
  return (
    <button className="reply-preview" onClick={() => onJump(reply.eventId)}>
      <span className="reply-preview__bar" />
      <span><Icon name="reply" /></span>
      {reply.senderName && (
        <span
          className="reply-preview__name"
          style={reply.senderId ? { color: colorFor(reply.senderId) } : undefined}
        >
          {reply.senderName}
        </span>
      )}
      <span className="reply-preview__body">{body}</span>
    </button>
  );
}

function ReceiptStack({ entry, vm }: { entry: EventEntry; vm: TimelineViewModel }) {
  if (entry.readReceipts.length === 0) {
    if (vm.showsSentTick(entry)) {
      return <div className="receipts"><span className="receipts__sent"><Icon name="check" /> Sent</span></div>;
    }
    return null;
  }
  return <ReceiptStackInner entry={entry} vm={vm} />;
}

function ReceiptStackInner({ entry, vm }: { entry: EventEntry; vm: TimelineViewModel }) {
  const [open, setOpen] = useState(false);
  const shown = entry.readReceipts.slice(0, 3);
  const overflow = entry.readReceipts.length - shown.length;
  const names = entry.readReceipts.map((uid) => vm.displayNameFor(uid));
  return (
    <div
      className="receipts"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {shown.map((uid, i) => (
        <ReceiptAvatar key={uid} userId={uid} first={i === 0} vm={vm} />
      ))}
      {overflow > 0 && <span className="receipts__overflow">+{overflow}</span>}
      {open && (
        // Immediate, all-at-once list of everyone who read.
        <div className="receipts-pop" role="tooltip">
          <div className="receipts-pop__title">Read by</div>
          {names.map((n, i) => (
            <div className="receipts-pop__row" key={`${n}-${i}`}>{n}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReceiptAvatar({
  userId,
  first,
  vm,
}: {
  userId: string;
  first: boolean;
  vm: TimelineViewModel;
}) {
  // The reader's avatar URL isn't on the entry, so resolve it from the shared
  // member-profile cache so real profile pictures show. RoomAvatar falls back to
  // a gradient initials disc keyed on the user id when there's no avatar.
  const session = useSession();
  const profile = useMemberProfile(session, vm.roomIdValue, userId);
  return (
    <span
      title={profile?.displayName ?? localpart(userId)}
      style={{
        marginLeft: first ? 0 : -5,
        borderRadius: "50%",
        border: "1.5px solid var(--bg-app)",
        display: "inline-flex",
        lineHeight: 0,
      }}
    >
      <RoomAvatar
        name={profile?.displayName ?? localpart(userId)}
        avatarUrl={profile?.avatarUrl}
        size={15}
      />
    </span>
  );
}

function ContextMenu(props: Props & { x: number; y: number; onClose: () => void }) {
  const { entry, vm, ownUserId, onReply, onEdit, onOpenThread, x, y, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // Clamp/flip the menu so it never opens off-screen (measure after mount).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - r.width - pad);
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad);
    setPos({ left, top });
  }, [x, y]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onClose]);

  const session = useSession();
  const customEmoji = useCustomEmoji(session);
  const c = entry.content;
  const isText = c.type === "text";
  const canEdit = entry.isOwn && entry.eventId != null && isText;

  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div className="ctx-menu" style={{ left: pos.left, top: pos.top }} ref={ref}>
      {/* Usage-based top-5 quick reactions plus "More Reactions" (any emoji or
          custom emote, reacting via its mxc url). Records usage so the quick
          set adapts. */}
      <ReactionPalette
        onToggle={(key) => void vm.toggleReaction(entry, key)}
        customEmoji={customEmoji}
        onClose={onClose}
      />
      {entry.canBeRepliedTo && (
        <button className="ctx-menu__item" onClick={act(() => onReply(entry))}>
          <Icon name="reply" /> Reply
        </button>
      )}
      {canEdit && (
        <button className="ctx-menu__item" onClick={act(() => onEdit(entry))}>
          <Icon name="edit" /> Edit Message
        </button>
      )}
      {entry.eventId && (
        <button className="ctx-menu__item" onClick={act(() => onOpenThread(entry.eventId!))}>
          <Icon name="thread" size={14} /> Reply in Thread
        </button>
      )}
      {isText && "body" in entry.content && (
        <button className="ctx-menu__item" onClick={act(() => void navigator.clipboard?.writeText((entry.content as { body: string }).body))}>
          <Icon name="copy" size={15} /> Copy Text
        </button>
      )}
      {entry.eventId && (
        <button className="ctx-menu__item" onClick={act(() => void navigator.clipboard?.writeText(entry.eventId!))}>
          <Icon name="hash" size={15} /> Copy Event ID
        </button>
      )}
      {"source" in c && (
        <>
          {c.type === "image" && (
            <button
              className="ctx-menu__item"
              onClick={act(() => void copyImage(session.mediaLoader, c.source, c.mimetype))}
            >
              <Icon name="copy" size={15} /> Copy Image
            </button>
          )}
          <button
            className="ctx-menu__item"
            onClick={act(() =>
              void saveMedia(session.mediaLoader, c.source, {
                mimetype: c.mimetype,
                filename: "body" in c ? c.body : undefined,
              }),
            )}
          >
            <Icon name="file" size={15} /> Save…
          </button>
        </>
      )}
      <button className="ctx-menu__item" onClick={act(() => modals.openProfile(entry.sender))}>
        <Icon name="people" size={15} /> View Profile
      </button>
      {entry.eventId &&
        (entry.isOwn ? vm.state.canRedactOwn : vm.state.canRedactOther) && (
          <button
            className="ctx-menu__item ctx-menu__item--danger"
            onClick={act(() => {
              if (!preferences.get("confirmBeforeDeleting" as never) || window.confirm("Delete this message?")) {
                void vm.redactEvent(entry);
              }
            })}
          >
            <Icon name="trash" /> {entry.isOwn ? "Delete Message" : "Remove Message"}
          </button>
        )}
      {!entry.isOwn && ownUserId && (
        <button
          className="ctx-menu__item ctx-menu__item--danger"
          onClick={act(() => {
            const reason = window.prompt("Report reason?");
            if (reason != null) void vm.report(entry, reason);
          })}
        >
          <Icon name="flag" size={14} /> Report Message…
        </button>
      )}
    </div>
  );
}

// --- helpers ---------------------------------------------------------------

function localpart(userId: string): string {
  if (!userId.startsWith("@")) return userId;
  const i = userId.indexOf(":");
  return i === -1 ? userId.slice(1) : userId.slice(1, i);
}

function mapsUrl(geoUri: string): string {
  // Turn a geo:lat,lon URI into an OpenStreetMap link.
  const m = /geo:([\d.-]+),([\d.-]+)/.exec(geoUri);
  if (!m) return geoUri;
  return `https://www.openstreetmap.org/?mlat=${m[1]}&mlon=${m[2]}#map=16/${m[1]}/${m[2]}`;
}
