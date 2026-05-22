import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type Workspace = {
  root: string;
  repoPath: string;
  briefPath: string;
};

export interface WorkspaceManager {
  create(workOrderId: string): Promise<Workspace>;
  cloneRepository(workspace: Workspace, targetRepo: string, targetBranch: string, token: string): Promise<void>;
  checkoutBranch(workspace: Workspace, branchName: string): Promise<void>;
  pushBranch(workspace: Workspace, branchName: string, token: string, targetRepo: string): Promise<void>;
  writeBrief(workspace: Workspace, brief: string): Promise<string>;
  destroy(workspace: Workspace): Promise<void>;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly result: CommandResult,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export class RealWorkspaceManager implements WorkspaceManager {
  constructor(private readonly workspaceRoot: string) {}

  async create(workOrderId: string): Promise<Workspace> {
    const root = join(this.workspaceRoot, workOrderId);
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true, mode: 0o700 });
    return { root, repoPath: join(root, "repo"), briefPath: join(root, "goal-brief.md") };
  }

  async cloneRepository(workspace: Workspace, targetRepo: string, targetBranch: string, token: string): Promise<void> {
    await this.withGitAskPass(workspace, token, async (env) => {
      await this.run(["git", "clone", "--depth", "1", "--branch", targetBranch, `https://github.com/${targetRepo}.git`, workspace.repoPath], workspace.root, {
        safeCommand: `git clone --depth 1 --branch ${targetBranch} https://github.com/${targetRepo}.git repo`,
        env,
        redact: [token],
      });
    });
  }

  async checkoutBranch(workspace: Workspace, branchName: string): Promise<void> {
    await this.run(["git", "checkout", "-b", branchName], workspace.repoPath);
  }

  async pushBranch(workspace: Workspace, branchName: string, token: string, targetRepo: string): Promise<void> {
    await this.withGitAskPass(workspace, token, async (env) => {
      await this.run(["git", "push", `https://github.com/${targetRepo}.git`, `HEAD:${branchName}`], workspace.repoPath, {
        safeCommand: `git push https://github.com/${targetRepo}.git HEAD:${branchName}`,
        env,
        redact: [token],
      });
    });
  }

  async writeBrief(workspace: Workspace, brief: string): Promise<string> {
    await writeFile(workspace.briefPath, brief, { encoding: "utf8", mode: 0o600 });
    return workspace.briefPath;
  }

  async destroy(workspace: Workspace): Promise<void> {
    await rm(workspace.root, { recursive: true, force: true });
  }

  private async withGitAskPass<T>(workspace: Workspace, token: string, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const askPassPath = join(workspace.root, `.git-askpass-${randomUUID()}.sh`);
    const script = [
      "#!/bin/sh",
      "case \"$1\" in",
      "  *Username*) printf '%s\\n' 'x-access-token' ;;",
      `  *Password*) printf '%s\\n' '${shellSingleQuote(token)}' ;;`,
      "  *) printf '%s\\n' '' ;;",
      "esac",
      "",
    ].join("\n");
    await writeFile(askPassPath, script, { encoding: "utf8", mode: 0o700 });
    await chmod(askPassPath, 0o700);
    try {
      return await fn({
        ...minimalGitEnv(process.env),
        GIT_ASKPASS: askPassPath,
        GIT_TERMINAL_PROMPT: "0",
      });
    } finally {
      await rm(askPassPath, { force: true });
    }
  }

  private async run(args: string[], cwd: string, opts: { safeCommand?: string; env?: Record<string, string>; redact?: string[] } = {}): Promise<CommandResult> {
    const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe", env: opts.env ?? minimalGitEnv(process.env) });
    const [rawStdout, rawStderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const stdout = redactSecrets(rawStdout, opts.redact ?? []);
    const stderr = redactSecrets(rawStderr, opts.redact ?? []);
    const result = { exitCode, stdout, stderr };
    if (exitCode !== 0) {
      const command = opts.safeCommand ?? args.map((arg) => redactSecrets(arg, opts.redact ?? [])).join(" ");
      throw new CommandError(`${command} failed with exit code ${exitCode}: ${stderr || stdout}`, command, result);
    }
    return result;
  }
}

export class MockWorkspaceManager implements WorkspaceManager {
  constructor(private readonly workspaceRoot: string) {}

  async create(workOrderId: string): Promise<Workspace> {
    const root = join(this.workspaceRoot, workOrderId);
    await rm(root, { recursive: true, force: true });
    await mkdir(join(root, "repo"), { recursive: true, mode: 0o700 });
    return { root, repoPath: join(root, "repo"), briefPath: join(root, "goal-brief.md") };
  }

  async cloneRepository(workspace: Workspace, targetRepo: string, targetBranch: string): Promise<void> {
    await writeFile(join(workspace.repoPath, "README.md"), `# Mock clone\n\n${targetRepo}@${targetBranch}\n`, "utf8");
  }

  async checkoutBranch(workspace: Workspace, branchName: string): Promise<void> {
    await writeFile(join(workspace.repoPath, ".mock-branch"), `${branchName}\n`, "utf8");
  }

  async pushBranch(): Promise<void> {
    // no-op: mock mode must not touch GitHub
  }

  async writeBrief(workspace: Workspace, brief: string): Promise<string> {
    await writeFile(workspace.briefPath, brief, { encoding: "utf8", mode: 0o600 });
    return workspace.briefPath;
  }

  async destroy(workspace: Workspace): Promise<void> {
    await rm(workspace.root, { recursive: true, force: true });
  }
}

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function minimalGitEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

function shellSingleQuote(value: string): string {
  return value.replace(/'/g, `'"'"'`);
}
