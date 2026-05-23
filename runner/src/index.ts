import { parseConfig } from "./config";
import { SupabaseControlPlane } from "./controlPlane";
import { GitHubApp, MockGitHubApp } from "./githubApp";
import { createLogger } from "./log";
import { RealClaudeCode, MockClaudeCode } from "./claudeCode";
import { MockWorkspaceManager, RealWorkspaceManager } from "./workspace";
import { RunnerDaemon } from "./runner";

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

main().catch((error) => {
  const logger = createLogger("runner");
  logger.error("runner daemon crashed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
