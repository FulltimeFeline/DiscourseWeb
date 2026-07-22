// Per-room composer drafts (localStorage) and the outgoing typing-notice throttle.

const DRAFT_PREFIX = "discourse.draft.";

export function loadDraft(roomId: string): string {
  try {
    return localStorage.getItem(DRAFT_PREFIX + roomId) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(roomId: string, text: string): void {
  try {
    if (text) localStorage.setItem(DRAFT_PREFIX + roomId, text);
    else localStorage.removeItem(DRAFT_PREFIX + roomId);
  } catch {
    /* storage full or disabled */
  }
}

/**
 * Throttled typing-notice controller: at most one `typingNotice(true)` per 4s,
 * an automatic stop 6s after the last keystroke, and an explicit stop before a
 * send. Gated externally by the sendTypingNotifications preference (the caller
 * only invokes `typing()` when enabled).
 */
export class TypingController {
  private lastSent = 0;
  private stopTimer?: number;

  constructor(private notify: (isTyping: boolean) => void) {}

  /** Call on each keystroke that leaves non-empty text. */
  typing(): void {
    const now = Date.now();
    if (now - this.lastSent >= 4000) {
      this.lastSent = now;
      this.notify(true);
    }
    if (this.stopTimer !== undefined) clearTimeout(this.stopTimer);
    this.stopTimer = window.setTimeout(() => this.stop(), 6000);
  }

  /** Explicitly stop (before a send, or when the field empties). */
  stop(): void {
    if (this.stopTimer !== undefined) {
      clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
    }
    if (this.lastSent !== 0) {
      this.lastSent = 0;
      this.notify(false);
    }
  }

  dispose(): void {
    if (this.stopTimer !== undefined) clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
  }
}
