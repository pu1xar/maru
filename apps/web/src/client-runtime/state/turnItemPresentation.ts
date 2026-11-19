// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: packages/client-runtime/src/state/turnItemPresentation.ts (turnItemIsWorkspacePreparation).
// Local changes: workspacePreparationRetryRunIds is left out (T3 run records only).
import type { OrchestrationV2TurnItem } from "@maru/shared";
import { ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE } from "../../t3-shared/contracts.ts";

const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";

export function turnItemIsWorkspacePreparation(item: OrchestrationV2TurnItem): boolean {
  return (
    (item.type === "command_execution" && item.input === WORKSPACE_PREPARATION_INPUT) ||
    (item.type === "error" &&
      item.status === "cancelled" &&
      item.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE)
  );
}
