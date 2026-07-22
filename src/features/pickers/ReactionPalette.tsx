// The reaction palette: a quick-react row plus a "More Reactions" entry.
//
// A row of the top-5 most-used unicode reactions (emoji-filtered, default-
// padded) plus a "More Reactions" entry that opens the full EmojiPicker.
// Toggling a reaction is delegated to the caller (the timeline provides
// `toggleReaction(itemId, key)`); custom emotes react with their MXC url as the
// key. Unicode keys are recorded to usage so the palette adapts over time.

import { useState } from "react";
import type { CustomEmojiStore } from "@/core/CustomEmojiStore";
import { EmojiPicker, type EmojiPick } from "./EmojiPicker";
import { rememberReaction, topReactions } from "./usage";
import { Icon } from "@/ui/Icon";
import "./ReactionPalette.css";

export interface ReactionPaletteProps {
  /** Toggle a reaction for the target item (unicode glyph or mxc url as key). */
  onToggle: (key: string) => void;
  customEmoji?: CustomEmojiStore;
  /** Called after any selection so a hovering/floating menu can dismiss. */
  onClose?: () => void;
}

export function ReactionPalette({ onToggle, customEmoji, onClose }: ReactionPaletteProps) {
  const [showFull, setShowFull] = useState(false);
  const quick = topReactions(5);

  function toggleUnicode(glyph: string) {
    rememberReaction(glyph);
    onToggle(glyph);
    onClose?.();
  }

  function onFullPick(pick: EmojiPick) {
    if (pick.kind === "unicode") {
      rememberReaction(pick.glyph);
      onToggle(pick.glyph);
    } else {
      // Custom emote reacts with its mxc url as the reaction key.
      onToggle(pick.mxc);
    }
    setShowFull(false);
    onClose?.();
  }

  if (showFull) {
    return (
      <div className="reaction-palette reaction-palette--full">
        <EmojiPicker customEmoji={customEmoji} onPick={onFullPick} allowCustom />
      </div>
    );
  }

  return (
    <div className="reaction-palette" role="toolbar" aria-label="Quick reactions">
      {quick.map((glyph) => (
        <button
          key={glyph}
          className="reaction-palette__quick"
          onClick={() => toggleUnicode(glyph)}
          aria-label={`React ${glyph}`}
        >
          {glyph}
        </button>
      ))}
      <button
        className="reaction-palette__more"
        onClick={() => setShowFull(true)}
        aria-label="More reactions"
        title="More Reactions…"
      >
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}
