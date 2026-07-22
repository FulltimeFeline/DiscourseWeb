// Poll-creation dialog.
//
// Question plus 2-8 options (add/remove, min 2 enforced) and a "Show results
// while the poll is open" toggle (disclosed vs undisclosed). Create is disabled
// until the question is non-empty and has >=2 non-empty options. maxSelections is
// hard-coded to 1 (single-choice). Trims and drops empty options on submit. The
// createPoll FFI call is delegated to the caller (the timeline).

import { useState } from "react";
import { Icon } from "@/ui/Icon";
import "./CreatePoll.css";

export interface CreatePollResult {
  question: string;
  answers: string[];
  kind: "disclosed" | "undisclosed";
  maxSelections: 1;
}

export interface CreatePollProps {
  onCreate: (poll: CreatePollResult) => void;
  onCancel: () => void;
}

const MAX_OPTIONS = 8;
const MIN_OPTIONS = 2;

export function CreatePoll({ onCreate, onCancel }: CreatePollProps) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [disclosed, setDisclosed] = useState(true);

  const trimmedOptions = options.map((o) => o.trim()).filter(Boolean);
  const canCreate = question.trim().length > 0 && trimmedOptions.length >= MIN_OPTIONS;

  function setOption(i: number, value: string) {
    setOptions((prev) => prev.map((o, idx) => (idx === i ? value : o)));
  }
  function addOption() {
    if (options.length < MAX_OPTIONS) setOptions((prev) => [...prev, ""]);
  }
  function removeOption(i: number) {
    if (options.length <= MIN_OPTIONS) return;
    setOptions((prev) => prev.filter((_, idx) => idx !== i));
  }

  function submit() {
    if (!canCreate) return;
    onCreate({
      question: question.trim(),
      answers: trimmedOptions,
      kind: disclosed ? "disclosed" : "undisclosed",
      maxSelections: 1,
    });
  }

  return (
    <div className="create-poll">
      <h3 className="create-poll__title">New Poll</h3>

      <label className="create-poll__label">Question</label>
      <input
        className="create-poll__input"
        type="text"
        placeholder="Ask a question"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        autoFocus
      />

      <label className="create-poll__label">Options</label>
      <div className="create-poll__options">
        {options.map((o, i) => (
          <div className="create-poll__option" key={i}>
            <input
              className="create-poll__input"
              type="text"
              placeholder={`Option ${i + 1}`}
              value={o}
              onChange={(e) => setOption(i, e.target.value)}
            />
            <button
              className="create-poll__remove"
              disabled={options.length <= MIN_OPTIONS}
              aria-label="Remove option"
              onClick={() => removeOption(i)}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
      {options.length < MAX_OPTIONS && (
        <button className="create-poll__add" onClick={addOption}>
          + Add option
        </button>
      )}

      <label className="create-poll__toggle">
        <input
          type="checkbox"
          checked={disclosed}
          onChange={(e) => setDisclosed(e.target.checked)}
        />
        Show results while the poll is open
      </label>

      <div className="create-poll__actions">
        <button className="create-poll__cancel" onClick={onCancel}>
          Cancel
        </button>
        <button className="create-poll__create" disabled={!canCreate} onClick={submit}>
          Create
        </button>
      </div>
    </div>
  );
}
