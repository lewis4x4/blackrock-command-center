import { readFile } from "node:fs/promises";

export type ClaudeGoalInput = {
  workspacePath: string;
  briefPath: string;
  costCapUsd: number | null;
  signal?: AbortSignal;
};

export type ClaudeGoalResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  costUsd: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
};

export interface ClaudeCodeRunner {
  runGoal(input: ClaudeGoalInput): Promise<ClaudeGoalResult>;
}

export class ClaudeGoalError extends Error {
  constructor(message: string, readonly result: ClaudeGoalResult) {
    super(message);
    this.name = "ClaudeGoalError";
  }
}

export class RealClaudeCode implements ClaudeCodeRunner {
  constructor(
    private readonly command = "claude",
    private readonly timeoutSeconds = 0,
  ) {}

  async runGoal(input: ClaudeGoalInput): Promise<ClaudeGoalResult> {
    const brief = await readFile(input.briefPath, "utf8");
    const prompt = `/goal\n\n${brief}`;
    const proc = Bun.spawn([this.command, "-p"], {
      cwd: input.workspacePath,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: buildClaudeEnv(process.env),
    });
    proc.stdin?.write(prompt);
    proc.stdin?.end();

    let aborted = false;
    let timedOut = false;
    const abort = () => {
      aborted = true;
      proc.kill("SIGTERM");
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    const timeout = this.timeoutSeconds > 0
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
        }, this.timeoutSeconds * 1000)
      : null;

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const result = {
        exitCode,
        stdout,
        stderr,
        ...parseUsage(stdout, stderr),
      };
      if (timedOut) throw new ClaudeGoalError(`Claude Code timed out after ${this.timeoutSeconds}s`, result);
      if (aborted || input.signal?.aborted) throw new ClaudeGoalError("Claude Code aborted after lease renewal failed", result);
      if (exitCode !== 0) throw new ClaudeGoalError(`Claude Code /goal failed with exit code ${exitCode}: ${stderr || stdout}`, result);
      return result;
    } finally {
      if (timeout) clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
  }
}

export class MockClaudeCode implements ClaudeCodeRunner {
  async runGoal(input: ClaudeGoalInput): Promise<ClaudeGoalResult> {
    if (input.signal?.aborted) throw new Error("mock Claude aborted before start");
    const brief = await readFile(input.briefPath, "utf8");
    return {
      exitCode: 0,
      stdout: `MOCK /goal received:\n${brief}`,
      stderr: "",
      costUsd: 0,
      tokensInput: Math.ceil(brief.length / 4),
      tokensOutput: 42,
    };
  }
}

export function buildClaudeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = [
    "PATH",
    "HOME",
    "SHELL",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ];
  const out: Record<string, string> = {};
  for (const key of allowed) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

function parseUsage(stdout: string, stderr: string): Pick<ClaudeGoalResult, "costUsd" | "tokensInput" | "tokensOutput"> {
  const text = `${stdout}\n${stderr}`;
  const costMatch = text.match(/cost(?:_usd| usd)?\s*[:=]\s*\$?([0-9]+(?:\.[0-9]+)?)/i);
  const inputMatch = text.match(/tokens[_\s-]*input\s*[:=]\s*([0-9]+)/i);
  const outputMatch = text.match(/tokens[_\s-]*output\s*[:=]\s*([0-9]+)/i);
  return {
    costUsd: costMatch?.[1] ? Number(costMatch[1]) : null,
    tokensInput: inputMatch?.[1] ? Number.parseInt(inputMatch[1], 10) : null,
    tokensOutput: outputMatch?.[1] ? Number.parseInt(outputMatch[1], 10) : null,
  };
}
