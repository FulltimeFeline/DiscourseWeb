// Public surface of the emotes feature. Consumed by the timeline + composer.

export { EmoteText, type EmoteTextProps } from "./EmoteText";
export { PollView, type PollViewProps } from "./PollView";
export { CreatePoll, type CreatePollProps, type CreatePollResult } from "./CreatePoll";
export {
  parsePowerLevelTags,
  displayTag,
  PowerLevelTagStore,
  type PowerLevelTag,
  type RoleTag,
} from "./PowerLevelTags";
export {
  parseInlineEmotes,
  segmentBody,
  buildHtmlBody,
  isEmoteOnly,
  isValidMxc,
  type EmoteSegment,
} from "./inlineEmotes";
export {
  detectColonQuery,
  emojiSuggestions,
  tryClosingColonReplace,
  applySuggestion,
  type EmojiSuggestion,
} from "./emojiAutocomplete";
