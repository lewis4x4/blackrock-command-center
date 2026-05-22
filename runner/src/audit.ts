import type { ControlPlane, UsageUpdate } from "./controlPlane";

export const RUNNER_ADAPTER = "claude_code_goal";

export function compactError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 2000) || "unknown runner error";
}

export function runNotes(parts: Array<string | null | undefined>): string {
  return parts.map((part) => part?.trim()).filter(Boolean).join("\n").slice(0, 8000);
}

export async function safeAudit(
  controlPlane: ControlPlane,
  appId: string | null,
  actor: string,
  eventType: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await controlPlane.writeAuditEvent(appId, actor, eventType, detail);
  } catch {
    // Queue RPCs already emit the critical audit events. This helper is best-effort only.
  }
}

export function usageFromClaude(result: { costUsd?: number | null; tokensInput?: number | null; tokensOutput?: number | null }): UsageUpdate {
  const usage: UsageUpdate = {};
  if (result.costUsd !== undefined) usage.costUsd = result.costUsd;
  if (result.tokensInput !== undefined) usage.tokensInput = result.tokensInput;
  if (result.tokensOutput !== undefined) usage.tokensOutput = result.tokensOutput;
  return usage;
}
