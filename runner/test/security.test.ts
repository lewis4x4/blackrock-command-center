import { describe, expect, test } from "bun:test";
import { buildClaudeEnv } from "../src/claudeCode";
import { redactSecrets } from "../src/workspace";

describe("runner security helpers", () => {
  test("Claude Code receives only allowlisted environment variables", () => {
    const env = buildClaudeEnv({
      PATH: "/bin",
      HOME: "/Users/runner",
      CONTROL_PLANE_SERVICE_KEY: "cp-secret",
      GITHUB_APP_PRIVATE_KEY: "github-private-key",
      GITHUB_TOKEN: "github-token",
      ANTHROPIC_API_KEY: "claude-secret",
    });

    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/Users/runner");
    expect(env.ANTHROPIC_API_KEY).toBe("claude-secret");
    expect(env.CONTROL_PLANE_SERVICE_KEY).toBeUndefined();
    expect(env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  test("git command output redaction removes token values", () => {
    expect(redactSecrets("fatal: token ghs_secret_token leaked", ["ghs_secret_token"])).toBe("fatal: token [redacted] leaked");
  });
});
