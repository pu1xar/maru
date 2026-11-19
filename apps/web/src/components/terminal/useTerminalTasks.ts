// The session's agents for the terminal mode's agent panel (terminalTasks.ts): the one place the
// terminal mode reads useSessionAgents. The panel needs every row, so it asks for the full list
// (`full`, DESIGN.md 6e).
import type { SessionAgentView } from "@maru/shared";

import { useSessionAgents } from "~/lib/sessionAgents";

export function useTerminalTasks(sessionKey: string): { agents: readonly SessionAgentView[]; running: number } {
  const { agents, running } = useSessionAgents(sessionKey, true);
  return { agents, running };
}
