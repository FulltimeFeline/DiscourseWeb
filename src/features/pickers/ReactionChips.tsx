// Reaction chips shown under a message.
//
// One chip per reaction key: unicode glyph or arbitrary text renders as text;
// an `mxc://` key renders as an image (custom emote) and resolves to a
// `:shortcode:` label via CustomEmojiStore.byUrl. Own reactions are tinted.
// Tapping a chip toggles your reaction; a trailing "+" opens the reaction
// picker. Hover reveals the sender list (title attribute).

import type { ReactionGroup } from "@/models/types";
import type { CustomEmojiStore } from "@/core/CustomEmojiStore";
import { EmoteImage } from "./EmoteImage";
import { Icon } from "@/ui/Icon";
import "./ReactionChips.css";

export interface ReactionChipsProps {
  reactions: ReactionGroup[];
  /** Toggle your reaction for a key (unicode / text / mxc url). */
  onToggle: (key: string) => void;
  /** Open the full reaction picker (the trailing "+" chip). */
  onOpenPicker?: () => void;
  customEmoji?: CustomEmojiStore;
  /** Resolve a userId to a display name for the hover sender list. */
  resolveName?: (userId: string) => string;
}

function isMxc(key: string): boolean {
  return key.startsWith("mxc://");
}

export function ReactionChips({
  reactions,
  onToggle,
  onOpenPicker,
  customEmoji,
  resolveName,
}: ReactionChipsProps) {
  if (reactions.length === 0 && !onOpenPicker) return null;

  return (
    <div className="reaction-chips">
      {reactions.map((r) => {
        const mxc = isMxc(r.key);
        const label = mxc
          ? customEmoji?.lookupByUrl(r.key)?.shortcode
          : undefined;
        const senderNames = resolveName
          ? r.senders.map(resolveName).join(", ")
          : r.senders.join(", ");
        const title = mxc && label ? `:${label}: — ${senderNames}` : senderNames;
        return (
          <button
            key={r.key}
            className={"reaction-chip" + (r.includesOwn ? " reaction-chip--own" : "")}
            title={title}
            onClick={() => onToggle(r.key)}
          >
            {mxc ? (
              <EmoteImage mxc={r.key} size={16} alt={label ? `:${label}:` : ""} />
            ) : (
              <span className="reaction-chip__key">{r.key}</span>
            )}
            <span className="reaction-chip__count">{r.senders.length}</span>
          </button>
        );
      })}
      {onOpenPicker && (
        <button
          className="reaction-chip reaction-chip--add"
          aria-label="Add reaction"
          onClick={onOpenPicker}
        >
          <Icon name="plus" size={14} />
        </button>
      )}
    </div>
  );
}
