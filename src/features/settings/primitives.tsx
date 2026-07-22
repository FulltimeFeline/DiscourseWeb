// Small presentational primitives shared by Settings, Room Settings, and Profile.
// No state library: plain components reading CSS variables from theme.css.

import type { ReactNode } from "react";
import { Icon } from "@/ui/Icon";

export function Modal({
  title,
  onClose,
  children,
  wide,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
}) {
  return (
    <div className="dm-scrim" onMouseDown={onClose}>
      <div
        className={`dm-modal${wide ? " dm-modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="dm-modal__head">
          <h2>{title}</h2>
          <button className="dm-iconbtn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="dm-modal__body">{children}</div>
        {footer && <footer className="dm-modal__foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Section({ title, footnote, children }: { title?: string; footnote?: string; children: ReactNode }) {
  return (
    <section className="dm-section">
      {title && <h3 className="dm-section__title">{title}</h3>}
      <div className="dm-section__body">{children}</div>
      {footnote && <p className="dm-section__foot">{footnote}</p>}
    </section>
  );
}

export function Row({ label, hint, control }: { label: string; hint?: string; control: ReactNode }) {
  return (
    <div className="dm-row">
      <div className="dm-row__labels">
        <span className="dm-row__label">{label}</span>
        {hint && <span className="dm-row__hint">{hint}</span>}
      </div>
      <div className="dm-row__control">{control}</div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`dm-toggle${checked ? " dm-toggle--on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="dm-toggle__knob" />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="dm-segmented" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          disabled={disabled}
          className={`dm-seg${o.value === value ? " dm-seg--on" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TextField({
  value,
  onChange,
  placeholder,
  multiline,
  disabled,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  disabled?: boolean;
  type?: string;
}) {
  if (multiline) {
    return (
      <textarea
        className="dm-input dm-input--area"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        rows={4}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      className="dm-input"
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  busy,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "destructive";
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      className={`dm-btn dm-btn--${variant}`}
      disabled={disabled || busy}
      onClick={onClick}
    >
      {busy ? <span className="dm-spinner" /> : children}
    </button>
  );
}

export function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="dm-ro">
      <span className="dm-ro__label">{label}</span>
      <code className="dm-ro__value" onClick={(e) => selectText(e.currentTarget)}>
        {value}
      </code>
    </div>
  );
}

function selectText(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}
