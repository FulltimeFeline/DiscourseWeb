// Poll rendering, voting, and ending.
//
// Renders a PollContent (models/types.ts): question, answers as votable rows,
// a radio indicator filled when voted-by-me, and, when results are shown, the
// vote count with a proportional tint fill bar. Results show when
// `isDisclosed || isEnded || votedByMe`. The author sees an "End Poll" button.
//
// Voting and ending are delegated to callbacks (the timeline provides
// sendPollResponse / endPoll). This view is presentational and optimistic: it
// flips votedByMe locally on vote so results re-reveal.

import { useMemo, useState } from "react";
import { Icon } from "@/ui/Icon";
import type { PollContent } from "@/models/types";
import "./PollView.css";

export interface PollViewProps {
  poll: PollContent;
  /** Our user id (to compute votedByMe from poll.votes). */
  ownUserId: string;
  /** True when this poll's start event was sent by us (author gate). */
  isOwn: boolean;
  /** Vote for an answer id (single-choice). */
  onVote: (answerId: string) => void;
  /** End the poll (author only). */
  onEnd: () => void;
}

export function PollView({ poll, ownUserId, isOwn, onVote, onEnd }: PollViewProps) {
  const isEnded = poll.endTs != null;
  const isDisclosed = poll.kind === "disclosed";

  // Optimistic local vote: which answer I picked this session (overrides
  // server votes until the timeline re-maps).
  const [localVote, setLocalVote] = useState<string | null>(null);

  const votedByMe = useMemo(() => {
    if (localVote) return localVote;
    for (const [answerId, voters] of Object.entries(poll.votes)) {
      if (voters.includes(ownUserId)) return answerId;
    }
    return null;
  }, [poll.votes, ownUserId, localVote]);

  const showResults = isDisclosed || isEnded || votedByMe != null;

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    let total = 0;
    for (const a of poll.answers) {
      const n = (poll.votes[a.id] ?? []).length + (localVote === a.id && !(poll.votes[a.id] ?? []).includes(ownUserId) ? 1 : 0);
      c[a.id] = n;
      total += n;
    }
    return { c, total };
  }, [poll.answers, poll.votes, localVote, ownUserId]);

  function vote(answerId: string) {
    if (isEnded) return;
    setLocalVote(answerId);
    onVote(answerId);
  }

  return (
    <div className="poll-view">
      <div className="poll-view__question">
        <span className="poll-view__icon" aria-hidden>
          <Icon name="poll" size={16} />
        </span>
        <span>{poll.question}</span>
      </div>

      <div className="poll-view__answers" role="group" aria-label="Poll answers">
        {poll.answers.map((a) => {
          const count = counts.c[a.id] ?? 0;
          const pct = counts.total > 0 ? (count / counts.total) * 100 : 0;
          const selected = votedByMe === a.id;
          return (
            <button
              key={a.id}
              className={"poll-view__answer" + (selected ? " poll-view__answer--selected" : "")}
              disabled={isEnded}
              aria-pressed={selected}
              aria-label={
                showResults ? `${a.text}, ${count} votes${selected ? ", selected" : ""}` : a.text
              }
              onClick={() => vote(a.id)}
            >
              {showResults && (
                <span className="poll-view__fill" style={{ width: `${pct}%` }} aria-hidden />
              )}
              <span
                className={"poll-view__radio" + (selected ? " poll-view__radio--on" : "")}
                aria-hidden
              />
              <span className="poll-view__answer-text">{a.text}</span>
              {showResults && <span className="poll-view__count">{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="poll-view__footer">
        {isEnded ? (
          <span>Final result — {counts.total} {counts.total === 1 ? "vote" : "votes"}</span>
        ) : (
          <span>
            {counts.total} {counts.total === 1 ? "vote" : "votes"}
            {!isDisclosed && " · Results shown when the poll ends"}
          </span>
        )}
        {isOwn && !isEnded && (
          <button className="poll-view__end" onClick={onEnd}>
            End Poll
          </button>
        )}
      </div>
    </div>
  );
}
