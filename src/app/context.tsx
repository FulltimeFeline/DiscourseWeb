import { createContext, useContext, type ReactNode } from "react";
import type { AppState } from "./AppState";
import type { MatrixSession } from "@/core/MatrixSession";

const AppContext = createContext<AppState | null>(null);
const SessionContext = createContext<MatrixSession | null>(null);

export function AppProvider({ app, children }: { app: AppState; children: ReactNode }) {
  return <AppContext.Provider value={app}>{children}</AppContext.Provider>;
}

export function SessionProvider({
  session,
  children,
}: {
  session: MatrixSession;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useApp(): AppState {
  const app = useContext(AppContext);
  if (!app) throw new Error("useApp must be used within <AppProvider>");
  return app;
}

/** The active signed-in session. Only valid inside the active shell. */
export function useSession(): MatrixSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used within <SessionProvider>");
  return session;
}
