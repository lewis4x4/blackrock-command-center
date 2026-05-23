import { parseConfig } from "./config";
import { SupabaseControlPlane } from "./controlPlane";
import { GitHubApp, MockGitHubApp } from "./githubApp";
import { createLogger } from "./log";
import { RealClaudeCode, MockClaudeCode } from "./claudeCode";
import { MockWorkspaceManager, RealWorkspaceManager } from "./workspace";
import { RunnerDaemon, type TelegramNotifyPayload } from "./runner";

async function main(): Promise<void> {
  const config = parseConfig();
  const logger = createLogger("runner");
  const controlPlane = new SupabaseControlPlane(config.controlPlaneUrl, config.controlPlaneServiceKey);

  const github = config.mockMode
    ? new MockGitHubApp()
    : new GitHubApp(config.githubAppId, config.githubAppPrivateKey, { logger });
  const workspaceManager = config.mockMode
    ? new MockWorkspaceManager(config.workspaceRoot)
    : new RealWorkspaceManager(config.workspaceRoot);
  const claudeCode = config.mockMode
    ? new MockClaudeCode()
    : new RealClaudeCode(config.claudeCodeCommand, config.claudeCodeTimeoutSeconds);

  logger.info("runner configuration loaded", {
    runner_id: config.runnerId,
    poll_interval_seconds: config.pollIntervalSeconds,
    lease_seconds: config.leaseSeconds,
    workspace_root: config.workspaceRoot,
    mock_mode: config.mockMode,
    concurrency: config.concurrency,
  });

  const daemon = new RunnerDaemon(
    {
      controlPlane,
      tokenProvider: github,
      pullRequestClient: github,
      workspaceManager,
      claudeCode,
      logger,
      telegramNotifier: createTelegramNotifier(config.controlPlaneUrl, config.controlPlaneServiceKey),
    },
    {
      runnerId: config.runnerId,
      leaseSeconds: config.leaseSeconds,
      pollIntervalSeconds: config.pollIntervalSeconds,
      extractionAutoCommitConfidence: config.extractionAutoCommitConfidence,
      extractionOffTopicFloor: config.extractionOffTopicFloor,
    },
  );

  const stop = () => daemon.requestStop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await daemon.runForever();
}

function createTelegramNotifier(controlPlaneUrl: string, serviceRoleKey: string): (payload: TelegramNotifyPayload) => Promise<void> {
  return async (payload: TelegramNotifyPayload): Promise<void> => {
    const response = await fetch(`${controlPlaneUrl}/functions/v1/cc-telegram-notify`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`cc-telegram-notify returned HTTP ${response.status}: ${text}`);
    if (!text) return;
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === "object" && "ok" in body && (body as { ok?: unknown }).ok === false) {
      throw new Error(`cc-telegram-notify returned ok=false: ${text}`);
    }
  };
}

main().catch((error) => {
  const logger = createLogger("runner");
  logger.error("runner daemon crashed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
