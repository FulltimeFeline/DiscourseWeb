import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  label?: string;
}
interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

/**
 * Catches render-time exceptions and shows them on screen (instead of a blank
 * page), so failures are debuggable without devtools. Wraps the app and the
 * signed-in shell.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[Discourse] render error", error, info);
    this.setState({ info });
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          overflow: "auto",
          padding: 24,
          background: "#140b0b",
          color: "#ffd7d7",
          font: "13px/1.5 ui-monospace, Menlo, monospace",
          zIndex: 9999,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
          {this.props.label ?? "App"} crashed: {error.name}: {error.message}
        </div>
        <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{error.stack}</pre>
        {info?.componentStack && (
          <>
            <div style={{ fontWeight: 700, margin: "16px 0 6px" }}>Component stack</div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0, opacity: 0.85 }}>
              {info.componentStack}
            </pre>
          </>
        )}
      </div>
    );
  }
}
