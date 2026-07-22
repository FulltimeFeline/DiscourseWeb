// The message composer.
//
// Self-contained: it obtains the FFI Timeline from the room and drives sending
// itself (text/markdown/HTML, reply, edit, attachments, voice) through
// composerSend.ts, so the timeline VM doesn't need to expose send methods. It
// also owns drafts, typing notices, @/:emoji autocomplete, attachment staging
// (drag/drop/paste), oversize rejection, and voice recording.
//
// Props: RoomPane renders
//   <Composer room={RoomSummary} session={MatrixSession}
//             replyTarget? editTarget? onClearReply? onClearEdit?
//             members? emojiSource? customHtml? shortcodeLookup? />

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MatrixSession } from "@/core/MatrixSession";
import type { RoomSummary } from "@/models/types";
import type { TimelineInterface, RoomInterface } from "@/matrix";
import { preferences } from "@/core/Preferences";
import { settingsPrefs } from "@/features/settings/settingsPrefs";
import { useStore } from "@/core/reactive";
import { VoiceRecorder, type Recording } from "@/features/media/VoiceRecorder";
import {
  editMessage as ffiEdit,
  sendAttachment,
  sendText as ffiSendText,
  sendVoiceMessage as ffiSendVoice,
  type StagedAttachment,
} from "./composerSend";
import { loadDraft, saveDraft, TypingController } from "./composerDrafts";
import { Icon } from "@/ui/Icon";
import {
  emojiSourceFor,
  refreshEmotePacks,
  useCustomEmoji,
  useStickerStore,
} from "@/features/emotes/emojiSession";
import { EmojiPicker, StickerPicker } from "@/features/pickers";
import { CreatePoll, type CreatePollResult } from "@/features/emotes/CreatePoll";
import { RoomAvatar } from "@/features/roomlist/RoomAvatar";
import type { StickerContent, Sticker } from "@/core/StickerStore";
import type { Emote } from "@/core/CustomEmojiStore";
import {
  applyEmoji,
  applyMention,
  autoReplaceShortcode,
  buildEmojiSuggestions,
  emojiQuery,
  fold,
  matchMentions,
  mentionQuery,
  type EmojiSuggestion,
  type MemberLike,
} from "./composerAutocomplete";
import "./composer.css";

// --- Props -----------------------------------------------------------------

export interface ComposerReplyTarget {
  eventId: string;
  senderName?: string;
  body?: string;
}
export interface ComposerEditTarget {
  eventId: string;
  /** Current text body to prefill. */
  body: string;
}

/** Pluggable emoji sources the emoji agent wires (all optional). */
export interface EmojiSource {
  /** Custom-emote matches for a `:query`. */
  customEmotes?: (q: string) => { prefix: EmojiSuggestion[]; contains: EmojiSuggestion[] };
  /** Unicode-emoji matches for a `:query`. */
  unicode?: (q: string, limit: number) => EmojiSuggestion[];
  /** Bare-shortcode → glyph, for inline auto-replace. */
  shortcodeLookup?: (shortcode: string) => string | undefined;
  /** Given the raw body, returns an MSC2545 HTML body if it has custom emotes. */
  customHtml?: (text: string) => string | undefined;
}

export interface ComposerProps {
  room: RoomSummary;
  session: MatrixSession;
  /** Reply banner state, owned by the timeline VM. */
  replyTarget?: ComposerReplyTarget;
  onClearReply?: () => void;
  /** Edit banner state, owned by the timeline VM. */
  editTarget?: ComposerEditTarget;
  onClearEdit?: () => void;
  /** Request the timeline VM start editing our last editable message (up-arrow in an empty field). */
  onEditLast?: () => void;
  /** Create + send a poll (from the attach menu). */
  onCreatePoll?: (poll: CreatePollResult) => void;
  /** Share the device's current location (from the attach menu). */
  onShareLocation?: () => void;
  /**
   * Override the timeline messages are SENT through. When set (thread composer),
   * sends go into that thread-focused timeline instead of the room's default one.
   */
  sendTimeline?: () => TimelineInterface | undefined;
  /** Room members for @-mention autocomplete; Composer loads them itself if omitted. */
  members?: MemberLike[];
  /** Emoji/custom-emote autocomplete hook (emoji agent wires this). */
  emojiSource?: EmojiSource;
}

// --- Staging types ---------------------------------------------------------

interface PendingAttachment {
  id: string;
  filename: string;
  file: File | Blob;
  mimetype: string;
  previewUrl?: string;
  isLoading: boolean;
  uploadFailed: boolean;
}

let nextId = 0;
const uid = () => `att-${nextId++}`;

// --- Component -------------------------------------------------------------

export function Composer(props: ComposerProps) {
  const { room, session, replyTarget, editTarget, onClearReply, onClearEdit, onEditLast, onCreatePoll, onShareLocation } = props;
  const prefs = useStore(preferences);
  const [attachMenu, setAttachMenu] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Emoji/custom-emote source: obtain it ourselves from the per-session stores
  // (room + session are already props) unless the caller supplied one. Subscribe
  // to the custom-emote store so autocomplete/HTML refresh as packs load.
  const customEmoji = useCustomEmoji(session);
  const stickerStore = useStickerStore(session);

  const emojiSource = useMemo(
    () => props.emojiSource ?? emojiSourceFor(session, room.id),
    // Rebuild when the emote index rebuilds so freshly-loaded packs are matchable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.emojiSource, session, room.id, customEmoji.version.value],
  );

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [members, setMembers] = useState<MemberLike[]>(props.members ?? []);

  // Emoji / sticker picker popovers.
  const [picker, setPicker] = useState<"emoji" | "sticker" | null>(null);

  // Whenever the picker opens, force a fresh aggregation of custom/server emote
  // + sticker packs. refreshEmotePacks awaits a fresh joined-spaces snapshot
  // first, so space-hosted packs load even if the background snapshot is still
  // empty (the 0-spaces case). Also pull this room's own pack.
  useEffect(() => {
    if (!picker) return;
    void customEmoji.ensureRoomPack(room.id);
    void refreshEmotePacks(session);
  }, [picker, customEmoji, session, room.id]);
  const composerRef = useRef<HTMLDivElement>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timelineRef = useRef<TimelineInterface | undefined>(undefined);
  const roomRef = useRef<RoomInterface | undefined>(undefined);
  const stashedDraft = useRef<string | null>(null);
  const maxUploadSize = useRef<number | undefined>(undefined);

  // --- Timeline + room handle ---------------------------------------------
  const sendTimeline = props.sendTimeline;
  useEffect(() => {
    let alive = true;
    const r = session.getRoom(room.id);
    roomRef.current = r;
    if (sendTimeline) {
      // Thread composer: send through the provided thread-focused timeline. It
      // is created asynchronously by the thread VM, so poll until it's ready.
      const tick = () => {
        if (!alive) return;
        const tl = sendTimeline();
        if (tl) timelineRef.current = tl;
        else window.setTimeout(tick, 150);
      };
      tick();
    } else {
      r?.timeline().then((tl) => {
        if (alive) timelineRef.current = tl;
      });
    }
    session.client.getMaxMediaUploadSize().then((n) => {
      maxUploadSize.current = Number(n);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [room.id, session, sendTimeline]);

  // --- Members for @-mentions (props override, else load once) ------------
  useEffect(() => {
    if (props.members) {
      setMembers(props.members);
      return;
    }
    let alive = true;
    const r = session.getRoom(room.id);
    r?.membersNoSync()
      .then((iter) => {
        const chunk = iter.nextChunk(1000) ?? [];
        if (!alive) return;
        setMembers(
          chunk.map((m) => ({
            userId: m.userId,
            displayName: m.displayName,
            foldedName: fold(m.displayName ?? m.userId),
            avatarUrl: m.avatarUrl,
          })),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [room.id, session, props.members]);

  // --- Typing controller ---------------------------------------------------
  const typing = useRef<TypingController | undefined>(undefined);
  useEffect(() => {
    typing.current = new TypingController((isTyping) => {
      roomRef.current?.typingNotice(isTyping).catch(() => {});
    });
    return () => typing.current?.dispose();
  }, [room.id]);

  // --- Draft restore / persist --------------------------------------------
  useEffect(() => {
    // Restore per-room draft on open (unless entering an edit).
    if (!editTarget) setText(loadDraft(room.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id]);

  // --- Edit mode: prefill + stash draft ------------------------------------
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editTarget && !wasEditing.current) {
      // draft-to-edit transition: stash the current draft once.
      stashedDraft.current = text;
      setText(editTarget.body);
      focusEnd();
    } else if (editTarget && wasEditing.current) {
      // switching between edit targets: keep original stash, just re-prefill.
      setText(editTarget.body);
      focusEnd();
    } else if (!editTarget && wasEditing.current) {
      // leaving edit: restore stashed draft.
      setText(stashedDraft.current ?? "");
      stashedDraft.current = null;
    }
    wasEditing.current = !!editTarget;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editTarget?.eventId]);

  // --- Autocomplete state --------------------------------------------------
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);

  const mention = useMemo(() => mentionQuery(text, caret), [text, caret]);
  const emote = useMemo(() => {
    if (mention) return undefined; // mention query suppresses emote query
    return emojiQuery(text, caret);
  }, [text, caret, mention]);

  const mentionMatches = useMemo(
    () => (mention ? matchMentions(members, mention.query, session.userId) : []),
    [mention, members, session.userId],
  );
  const emojiMatches = useMemo(
    () => (emote && emojiSource ? buildEmojiSuggestions(emote.query, emojiSource) : []),
    [emote, emojiSource],
  );

  const showMentions = mention && mentionMatches.length > 0;
  const showEmotes = !showMentions && emote && emojiMatches.length > 0;
  const suggestionCount = showMentions ? mentionMatches.length : showEmotes ? emojiMatches.length : 0;

  useEffect(() => setSelected(0), [mention?.at, emote?.at, suggestionCount]);

  // --- Derived -------------------------------------------------------------
  const trimmed = text.trim();
  const canSend = trimmed.length > 0 || attachments.some((a) => !a.isLoading);
  const placeholder = `Message ${room.name}`;

  function focusEnd() {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    });
  }

  // --- Text change (draft, typing, inline shortcode replace) ---------------
  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const el = e.target;
      let next = el.value;
      let nextCaret = el.selectionStart ?? next.length;

      // Inline unicode-shortcode auto-replace on a single-char `:` completion.
      if (emojiSource?.shortcodeLookup) {
        const replaced = autoReplaceShortcode(text, next, nextCaret, emojiSource.shortcodeLookup);
        if (replaced) {
          next = replaced.text;
          nextCaret = replaced.caret;
        }
      }

      setText(next);
      setCaret(nextCaret);
      setError(undefined);

      // Draft persistence (not while editing).
      if (!editTarget) saveDraft(room.id, next);

      // Typing notice.
      if (next.trim() && prefs.sendTypingNotifications) typing.current?.typing();
      else if (!next.trim()) typing.current?.stop();
    },
    [text, editTarget, room.id, prefs.sendTypingNotifications, emojiSource],
  );

  // --- Autocomplete accept -------------------------------------------------
  const acceptSuggestion = useCallback(() => {
    if (showMentions && mention) {
      const r = applyMention(text, caret, mention.at, mentionMatches[selected].member);
      setText(r.text);
      setCaret(r.caret);
      if (!editTarget) saveDraft(room.id, r.text);
      focusEnd();
      return true;
    }
    if (showEmotes && emote) {
      const r = applyEmoji(text, caret, emote.at, emojiMatches[selected]);
      setText(r.text);
      setCaret(r.caret);
      if (!editTarget) saveDraft(room.id, r.text);
      focusEnd();
      return true;
    }
    return false;
  }, [showMentions, showEmotes, mention, emote, text, caret, selected, mentionMatches, emojiMatches, editTarget, room.id]);

  // --- Emoji / sticker picker ----------------------------------------------
  // Insert a token/glyph at the caret (or end), keeping the draft in sync.
  const insertAtCaret = useCallback(
    (insert: string, trailingSpace = true) => {
      const el = textareaRef.current;
      const at = el?.selectionStart ?? text.length;
      const before = text.slice(0, at);
      const after = text.slice(at);
      const spaced = trailingSpace ? `${insert} ` : insert;
      const next = before + spaced + after;
      setText(next);
      const nextCaret = before.length + spaced.length;
      setCaret(nextCaret);
      if (!editTarget) saveDraft(room.id, next);
      requestAnimationFrame(() => {
        const e2 = textareaRef.current;
        if (e2) {
          e2.focus();
          e2.setSelectionRange(nextCaret, nextCaret);
        }
      });
    },
    [text, editTarget, room.id],
  );

  const onPickEmoji = useCallback(
    (pick: { kind: "unicode"; glyph: string } | { kind: "custom"; mxc: string; shortcode: string }) => {
      // Unicode glyphs insert with no trailing space, so you can chain emoji.
      // Custom-emote `:shortcode:` tokens get a trailing space so the next word
      // doesn't fuse into the shortcode.
      if (pick.kind === "unicode") insertAtCaret(pick.glyph, false);
      else insertAtCaret(`:${pick.shortcode}:`, true);
      setPicker(null);
    },
    [insertAtCaret],
  );

  const sendSticker = useCallback(
    async (content: StickerContent) => {
      await stickerStore.send(room.id, content);
      setPicker(null);
    },
    [stickerStore, room.id],
  );

  const sendPackSticker = useCallback(
    async (emote: Emote) => {
      await stickerStore.send(room.id, {
        body: emote.body ?? `:${emote.shortcode}:`,
        url: emote.url,
        info: emote.info,
      });
      setPicker(null);
    },
    [stickerStore, room.id],
  );

  // --- Send ----------------------------------------------------------------
  const doSend = useCallback(async () => {
    const timeline = timelineRef.current;
    if (!timeline || !canSend) return;

    const body = text.trim();
    const ready = attachments.filter((a) => !a.isLoading);
    const stillLoading = attachments.filter((a) => a.isLoading);

    // Optimistic clear (and re-clear next frame to kill a stray newline).
    setText("");
    setAttachments(stillLoading);
    if (!editTarget) saveDraft(room.id, "");
    requestAnimationFrame(() => setText((t) => (t === "\n" ? "" : t)));
    typing.current?.stop();

    // Edit path.
    if (editTarget) {
      try {
        await ffiEdit(timeline, editTarget.eventId, body, emojiSource?.customHtml);
      } catch (err) {
        setError(String(err));
      }
      onClearEdit?.();
      return;
    }

    const replyId = replyTarget?.eventId;
    const noText = body.length === 0;

    // Attachments first (the first carries the reply relation when there's no text).
    const failed: PendingAttachment[] = [];
    for (let i = 0; i < ready.length; i++) {
      const att = ready[i];
      const staged: StagedAttachment = {
        id: att.id,
        filename: att.filename,
        file: att.file,
        mimetype: att.mimetype,
      };
      // Oversize rejection.
      const max = maxUploadSize.current;
      if (max != null && att.file.size > max) {
        setError(`${att.filename} is too large to send (limit ${Math.round(max / (1024 * 1024))} MB).`);
        continue;
      }
      const inReplyTo = i === 0 && noText ? replyId : undefined;
      try {
        await sendAttachment(timeline, staged, {
          inReplyTo,
          stripLocation: settingsPrefs.get("stripLocationMetadata"),
        });
      } catch {
        failed.push({ ...att, uploadFailed: true, isLoading: false });
      }
    }
    if (failed.length) setAttachments((prev) => [...prev, ...failed]);

    // Text (as its own following message).
    if (!noText) {
      try {
        await ffiSendText(timeline, body, {
          replyToEventId: replyId,
          customHtml: emojiSource?.customHtml,
        });
      } catch (err) {
        setError(String(err));
        setText(body); // restore on failure
      }
    }

    onClearReply?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, attachments, canSend, editTarget, replyTarget, room.id, emojiSource, onClearEdit, onClearReply]);

  // --- Keyboard ------------------------------------------------------------
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Autocomplete navigation takes precedence.
      if (suggestionCount > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelected((s) => (s + 1) % suggestionCount);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelected((s) => (s - 1 + suggestionCount) % suggestionCount);
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          acceptSuggestion();
          return;
        }
        if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
          if (acceptSuggestion()) {
            e.preventDefault();
            return;
          }
        }
      }

      // Escape backs out in order: recording, then edit, then reply.
      if (e.key === "Escape") {
        if (recording) {
          e.preventDefault();
          cancelRecording();
          return;
        }
        if (editTarget) {
          e.preventDefault();
          onClearEdit?.();
          return;
        }
        if (replyTarget) {
          e.preventDefault();
          onClearReply?.();
          return;
        }
        return;
      }

      // Up arrow in an empty field edits the last own message.
      if (e.key === "ArrowUp" && text.length === 0 && !editTarget) {
        e.preventDefault();
        onEditLast?.();
        return;
      }

      // Enter-to-send semantics. Alt+Enter is always a newline.
      if (e.key === "Enter") {
        if (e.altKey) return; // newline
        const sendOnEnter = prefs.sendOnEnter;
        const isSend = sendOnEnter
          ? !e.shiftKey // plain/cmd sends; shift is a newline
          : e.shiftKey || e.metaKey || e.ctrlKey; // inverted: shift/cmd sends
        if (isSend) {
          e.preventDefault();
          void doSend();
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [suggestionCount, acceptSuggestion, editTarget, replyTarget, text, prefs.sendOnEnter, doSend, onEditLast, onClearEdit, onClearReply],
  );

  // --- Dismiss the picker popover on outside click / room switch -----------
  useEffect(() => {
    if (!picker) return;
    const onDown = (e: MouseEvent) => {
      if (composerRef.current && !composerRef.current.contains(e.target as Node)) {
        setPicker(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [picker]);
  useEffect(() => setPicker(null), [room.id]);

  // --- Auto-grow textarea --------------------------------------------------
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const line = 22; // approx line height px
    const max = line * 8 + 20;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text]);

  // --- Attachment staging --------------------------------------------------
  const stageFiles = useCallback((files: FileList | File[]) => {
    const staged: PendingAttachment[] = [];
    for (const file of Array.from(files)) {
      const isImage = file.type.startsWith("image/");
      staged.push({
        id: uid(),
        filename: (file as File).name || `file-${Date.now()}`,
        file,
        mimetype: file.type || "application/octet-stream",
        previewUrl: isImage ? URL.createObjectURL(file) : undefined,
        isLoading: false,
        uploadFailed: false,
      });
    }
    setAttachments((prev) => [...prev, ...staged]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const a = prev.find((x) => x.id === id);
      if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  }, []);

  // Revoke object URLs on unmount.
  useEffect(() => {
    return () => {
      attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Drag / drop / paste -------------------------------------------------
  const [dragOver, setDragOver] = useState(false);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length) stageFiles(e.dataTransfer.files);
    },
    [stageFiles],
  );
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = e.clipboardData.files;
      if (files && files.length) {
        e.preventDefault();
        stageFiles(files);
      }
      // else: plain text pastes normally.
    },
    [stageFiles],
  );

  // --- Voice recording -----------------------------------------------------
  const [recording, setRecording] = useState(false);
  const [recError, setRecError] = useState<string | undefined>();
  const recorderRef = useRef<VoiceRecorder | undefined>(undefined);
  const [recTick, setRecTick] = useState(0);
  const recTimer = useRef<number | undefined>(undefined);

  const startRecording = useCallback(async () => {
    setRecError(undefined);
    const rec = new VoiceRecorder();
    recorderRef.current = rec;
    try {
      await rec.start();
      setRecording(true);
      recTimer.current = window.setInterval(() => {
        if (rec.interrupted) {
          setRecError("Recording interrupted");
          cancelRecording();
          return;
        }
        setRecTick((t) => t + 1);
      }, 100);
    } catch {
      setRecError("Microphone permission denied");
      recorderRef.current = undefined;
    }
  }, []);

  const cancelRecording = useCallback(() => {
    if (recTimer.current) clearInterval(recTimer.current);
    recTimer.current = undefined;
    recorderRef.current?.stop(true);
    recorderRef.current = undefined;
    setRecording(false);
  }, []);

  const finishRecording = useCallback(async () => {
    if (recTimer.current) clearInterval(recTimer.current);
    recTimer.current = undefined;
    const rec = recorderRef.current;
    recorderRef.current = undefined;
    setRecording(false);
    if (!rec) return;
    const result: Recording | undefined = await rec.stop(false);
    const timeline = timelineRef.current;
    if (result && timeline) {
      try {
        await ffiSendVoice(timeline, result, replyTarget?.eventId);
        onClearReply?.();
      } catch (err) {
        setError(String(err));
      }
    }
  }, [replyTarget, onClearReply]);

  // Teardown a live recording on room switch / unmount.
  useEffect(() => {
    return () => {
      if (recTimer.current) clearInterval(recTimer.current);
      recorderRef.current?.stop(true);
    };
  }, [room.id]);

  // --- Render --------------------------------------------------------------
  return (
    <div
      ref={composerRef}
      className={`dc-composer${dragOver ? " drag" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* Autocomplete popup */}
      {(showMentions || showEmotes) && (
        <div className="dc-ac-popup" role="listbox">
          {showMentions &&
            mentionMatches.map((m, i) => (
              <div
                key={m.member.userId}
                className={`dc-ac-row${i === selected ? " sel" : ""}`}
                onMouseEnter={() => setSelected(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setSelected(i);
                  acceptSuggestion();
                }}
                role="option"
                aria-selected={i === selected}
              >
                <span className="dc-ac-avatar" aria-hidden>
                  <RoomAvatar
                    name={m.member.displayName || m.member.userId}
                    avatarUrl={m.member.avatarUrl}
                    size={22}
                  />
                </span>
                <span className="dc-ac-name">{m.member.displayName || m.member.userId}</span>
                <span className="dc-ac-mxid">{m.member.userId}</span>
              </div>
            ))}
          {showEmotes &&
            emojiMatches.map((s, i) => (
              <div
                key={s.label + i}
                className={`dc-ac-row${i === selected ? " sel" : ""}`}
                onMouseEnter={() => setSelected(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setSelected(i);
                  acceptSuggestion();
                }}
                role="option"
                aria-selected={i === selected}
              >
                <span className="dc-ac-emoji">{s.mxc ? <Icon name="image" /> : s.insert}</span>
                <span className="dc-ac-name">{s.label}</span>
              </div>
            ))}
        </div>
      )}

      {/* Reply / edit banner */}
      {editTarget && (
        <div className="dc-banner">
          <span>Editing message</span>
          <button className="dc-banner-x" onClick={onClearEdit} aria-label="Cancel edit">
            <Icon name="x" size={16} />
          </button>
        </div>
      )}
      {!editTarget && replyTarget && (
        <div className="dc-banner">
          <span>Replying to {replyTarget.senderName ?? "message"}</span>
          <button className="dc-banner-x" onClick={onClearReply} aria-label="Cancel reply">
            <Icon name="x" size={16} />
          </button>
        </div>
      )}

      {/* Error */}
      {(error || recError) && <div className="dc-error">{error ?? recError}</div>}

      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="dc-chips">
          {attachments.map((a) => (
            <div
              key={a.id}
              className={`dc-chip${a.uploadFailed ? " failed" : ""}`}
              title={a.filename}
            >
              {a.previewUrl ? (
                <img src={a.previewUrl} alt={a.filename} />
              ) : (
                <span className="dc-chip-doc" aria-hidden>
                  <Icon name="file" />
                </span>
              )}
              {a.isLoading && <span className="dc-spinner small dc-chip-spin" />}
              <button
                className="dc-chip-x"
                onClick={() => removeAttachment(a.id)}
                aria-label={`Remove ${a.filename}`}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Emoji/sticker picker popover: two tabs, anchored to the right button */}
      {picker && (
        <div className="dc-picker-pop dc-picker-pop--right" role="dialog">
          <div className="dc-picker-tabs">
            <button
              type="button"
              className={`dc-picker-tab${picker === "emoji" ? " dc-picker-tab--on" : ""}`}
              onClick={() => setPicker("emoji")}
            >
              <Icon name="smile" size={15} /> Emoji
            </button>
            <button
              type="button"
              className={`dc-picker-tab${picker === "sticker" ? " dc-picker-tab--on" : ""}`}
              onClick={() => setPicker("sticker")}
            >
              <Icon name="image" size={15} /> Stickers
            </button>
          </div>
          <div className="dc-picker-body">
            {picker === "emoji" ? (
              <EmojiPicker customEmoji={customEmoji} onPick={onPickEmoji} allowCustom />
            ) : (
              <StickerPicker
                stickerStore={stickerStore}
                customEmoji={customEmoji}
                onSendPersonal={(content: StickerContent, _s: Sticker) => void sendSticker(content)}
                onSendPackSticker={(emote: Emote) => void sendPackSticker(emote)}
              />
            )}
          </div>
        </div>
      )}

      {/* Input row */}
      <div className="dc-input-row">
        {!recording && (
          <>
            <div className="dc-attach-wrap">
              <button
                type="button"
                className="dc-attach-btn"
                aria-label="Attach"
                aria-expanded={attachMenu}
                onClick={() => setAttachMenu((v) => !v)}
              >
                <Icon name="plus" size={18} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,video/*,*/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  if (e.target.files) stageFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              {attachMenu && (
                <>
                  <div className="dc-attach-backdrop" onClick={() => setAttachMenu(false)} />
                  <div className="dc-attach-menu" role="menu">
                    <button
                      type="button"
                      className="dc-attach-item"
                      onClick={() => {
                        setAttachMenu(false);
                        fileInputRef.current?.click();
                      }}
                    >
                      <Icon name="file" size={16} /> Attach file
                    </button>
                    {onCreatePoll && (
                      <button
                        type="button"
                        className="dc-attach-item"
                        onClick={() => {
                          setAttachMenu(false);
                          setPollOpen(true);
                        }}
                      >
                        <Icon name="poll" size={16} /> Create poll…
                      </button>
                    )}
                    {onShareLocation && (
                      <button
                        type="button"
                        className="dc-attach-item"
                        onClick={() => {
                          setAttachMenu(false);
                          onShareLocation();
                        }}
                      >
                        <Icon name="pin" size={16} /> Share location
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
            <textarea
              ref={textareaRef}
              className="dc-textarea"
              value={text}
              placeholder={placeholder}
              rows={1}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
              onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            />
          </>
        )}

        {recording && (
          <div className="dc-recording">
            <span className="dc-rec-dot" aria-hidden />
            <span className="dc-rec-time">{formatRec(recorderRef.current?.duration ?? 0)}</span>
            <div className="dc-rec-wave" data-tick={recTick}>
              {(recorderRef.current?.levels ?? []).slice(-60).map((l, i) => (
                <span key={i} style={{ height: `${Math.max(8, Math.round(l * 100))}%` }} />
              ))}
            </div>
            <button className="dc-rec-cancel" onClick={cancelRecording} aria-label="Cancel recording">
              <Icon name="x" size={16} />
            </button>
            <button className="dc-send-btn" onClick={finishRecording} aria-label="Send voice message">
              <Icon name="send" size={18} />
            </button>
          </div>
        )}

        {!recording && (
          <button
            type="button"
            className="dc-emoji-btn"
            aria-label="Emoji & stickers"
            aria-expanded={!!picker}
            onClick={() => setPicker((p) => (p ? null : "emoji"))}
          >
            <Icon name="smile" size={18} />
          </button>
        )}

        {!recording &&
          (canSend ? (
            <button className="dc-send-btn" onClick={() => void doSend()} aria-label="Send message">
              <Icon name="send" size={18} />
            </button>
          ) : (
            <button
              className="dc-mic-btn"
              onClick={() => void startRecording()}
              aria-label="Record voice message"
            >
              <Icon name="mic" size={18} />
            </button>
          ))}
      </div>
      {pollOpen && onCreatePoll && (
        <CreatePoll
          onCreate={(poll) => {
            onCreatePoll(poll);
            setPollOpen(false);
          }}
          onCancel={() => setPollOpen(false)}
        />
      )}
    </div>
  );
}

function formatRec(secs: number): string {
  const s = Math.floor(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
