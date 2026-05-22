export type RunnerConfig = {
  controlPlaneUrl: string;
  controlPlaneServiceKey: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  runnerId: string;
  pollIntervalSeconds: number;
  leaseSeconds: number;
  workspaceRoot: string;
  concurrency: 1;
  mockMode: boolean;
  claudeCodeCommand: string;
  claudeCodeTimeoutSeconds: number;
};

type Env = Record<string, string | undefined>;

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw == null || raw.trim() === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function parseIntEnv(name: string, raw: string | undefined, defaultValue: number, opts: { min: number; max?: number }): number {
  if (raw == null || raw.trim() === "") return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < opts.min || (opts.max != null && parsed > opts.max)) {
    const upper = opts.max == null ? "" : ` and <= ${opts.max}`;
    throw new Error(`${name} must be an integer >= ${opts.min}${upper}`);
  }
  return parsed;
}

function required(name: string, env: Env): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function parseConfig(env: Env = process.env): RunnerConfig {
  const mockMode = parseBoolean(env.RUNNER_MOCK_MODE, false);
  const controlPlaneUrl = required("CONTROL_PLANE_URL", env).replace(/\/+$/, "");
  const controlPlaneServiceKey = required("CONTROL_PLANE_SERVICE_KEY", env);

  const githubAppId = mockMode ? (env.GITHUB_APP_ID?.trim() ?? "mock-app") : required("GITHUB_APP_ID", env);
  const githubAppPrivateKey = mockMode
    ? (env.GITHUB_APP_PRIVATE_KEY?.trim() ?? "mock-private-key")
    : required("GITHUB_APP_PRIVATE_KEY", env);

  const concurrency = parseIntEnv("CONCURRENCY", env.CONCURRENCY, 1, { min: 1, max: 1 }) as 1;

  return {
    controlPlaneUrl,
    controlPlaneServiceKey,
    githubAppId,
    githubAppPrivateKey,
    runnerId: env.RUNNER_ID?.trim() || "mac-studio-1",
    pollIntervalSeconds: parseIntEnv("POLL_INTERVAL_SECONDS", env.POLL_INTERVAL_SECONDS, 10, { min: 1 }),
    leaseSeconds: parseIntEnv("LEASE_SECONDS", env.LEASE_SECONDS, 600, { min: 30, max: 3600 }),
    workspaceRoot: env.WORKSPACE_ROOT?.trim() || "/tmp/cc-runner",
    concurrency,
    mockMode,
    claudeCodeCommand: env.CLAUDE_CODE_COMMAND?.trim() || "claude",
    claudeCodeTimeoutSeconds: parseIntEnv("CLAUDE_CODE_TIMEOUT_SECONDS", env.CLAUDE_CODE_TIMEOUT_SECONDS, 0, { min: 0 }),
  };
}
