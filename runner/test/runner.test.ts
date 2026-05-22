import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockWorkspaceManager } from "../src/workspace";
import { executeWorkOrder, type RunnerDeps } from "../src/runner";
import { MockGitHubApp } from "../src/githubApp";
import type { AgentRun, ControlPlane, FinishRunInput, RewriteTask, UsageUpdate, WorkOrder } from "../src/controlPlane";
import type { ClaudeCodeRunner, ClaudeGoalInput, ClaudeGoalResult, ClaudePromptInput } from "../src/claudeCode";
import { createLogger } from "../src/log";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sampleWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    app_id: "22222222-2222-4222-8222-222222222222",
    target_repo: "lewis4x4/qep",
    target_branch: "main",
    change_spec: {
      intent: "Add the mock runner smoke marker",
      affected_area: "runner smoke harness",
      acceptance_criteria: ["PR opens with a smoke marker", "No merge is attempted"],
      constraints: ["Do not touch production secrets"],
    },
    source_answer_id: null,
    risk_class: "auto",
    idempotency_key: "test-key",
    cost_cap_usd: "2.50",
    status: "claimed",
    claimed_by: "mac-studio-1",
    attempt_count: 1,
    max_attempts: 3,
    pr_url: null,
    ...overrides,
  };
}

class FakeControlPlane implements ControlPlane {
  completed: Array<{ workOrderId: string; prUrl: string }> = [];
  failed: Array<{ workOrderId: string; runnerId: string; error: string }> = [];
  finishedRuns: FinishRunInput[] = [];
  heartbeats = 0;
  audits: Array<{ eventType: string; actor: string }> = [];

  async claimWorkOrder(): Promise<WorkOrder | null> { return null; }
  async claimRewriteTask(): Promise<RewriteTask | null> { return null; }
  async finishRewriteTask(): Promise<RewriteTask> { throw new Error('not implemented in test fake'); }
  async failRewriteTask(): Promise<RewriteTask> { throw new Error('not implemented in test fake'); }
  async renewLease(): Promise<WorkOrder | null> { this.heartbeats += 1; return sampleWorkOrder(); }
  async completeWorkOrder(workOrderId: string, prUrl: string): Promise<WorkOrder> {
    this.completed.push({ workOrderId, prUrl });
    return sampleWorkOrder({ status: "pr_open", pr_url: prUrl });
  }
  async failWorkOrder(workOrderId: string, runnerId: string, error: string): Promise<WorkOrder> {
    this.failed.push({ workOrderId, runnerId, error });
    return sampleWorkOrder({ status: "failed" });
  }
  async createAgentRun(workOrderId: string, runner: string): Promise<AgentRun> {
    return {
      id: "run-1",
      work_order_id: workOrderId,
      runner,
      started_at: new Date().toISOString(),
      finished_at: null,
      heartbeat_at: null,
      status: "running",
      cost_usd: null,
      tokens_input: null,
      tokens_output: null,
      pr_url: null,
      notes: null,
    };
  }
  async heartbeatAgentRun(_runId: string, _usage?: UsageUpdate): Promise<AgentRun> { this.heartbeats += 1; return this.createAgentRun("wo", "runner"); }
  async finishAgentRun(_runId: string, input: FinishRunInput): Promise<AgentRun> {
    this.finishedRuns.push(input);
    return { ...(await this.createAgentRun("wo", "runner")), status: input.status, finished_at: new Date().toISOString(), pr_url: input.prUrl ?? null, notes: input.notes ?? null };
  }
  async getGitHubInstallationId(): Promise<string | null> { return "12345"; }
  async writeAuditEvent(_appId: string | null, actor: string, eventType: string): Promise<void> { this.audits.push({ actor, eventType }); }
}

class RecordingClaude implements ClaudeCodeRunner {
  brief = "";
  async runPrompt(_input: ClaudePromptInput): Promise<ClaudeGoalResult> {
    throw new Error('not implemented in test fake');
  }
  async runGoal(input: ClaudeGoalInput): Promise<ClaudeGoalResult> {
    this.brief = await readFile(input.briefPath, "utf8");
    return {
      exitCode: 0,
      stdout: `done ${input.costCapUsd}`,
      stderr: "",
      costUsd: 0.12,
      tokensInput: 100,
      tokensOutput: 25,
    };
  }
}

class FailingClaude implements ClaudeCodeRunner {
  async runPrompt(_input: ClaudePromptInput): Promise<ClaudeGoalResult> {
    throw new Error('Claude Code exploded');
  }
  async runGoal(): Promise<ClaudeGoalResult> {
    throw new Error("Claude Code exploded");
  }
}

async function makeDeps(claudeCode: ClaudeCodeRunner) {
  const root = await mkdtemp(join(tmpdir(), "cc-runner-test-"));
  tempRoots.push(root);
  const controlPlane = new FakeControlPlane();
  const github = new MockGitHubApp();
  const deps: RunnerDeps = {
    controlPlane,
    tokenProvider: github,
    pullRequestClient: github,
    workspaceManager: new MockWorkspaceManager(root),
    claudeCode,
    logger: createLogger("runner-test"),
  };
  return { deps, controlPlane, root };
}

describe("executeWorkOrder", () => {
  test("runs the full happy path with mocked GitHub and mocked /goal", async () => {
    const claude = new RecordingClaude();
    const { deps, controlPlane, root } = await makeDeps(claude);
    const workOrder = sampleWorkOrder();

    const result = await executeWorkOrder(workOrder, deps, { runnerId: "mac-studio-1", leaseSeconds: 600 });

    expect(result.status).toBe("succeeded");
    expect(result.prUrl).toBe(`https://github.com/${workOrder.target_repo}/pull/mock-${workOrder.id}`);
    const prUrl = result.prUrl!;
    expect(controlPlane.completed).toEqual([{ workOrderId: workOrder.id, prUrl }]);
    expect(controlPlane.failed).toHaveLength(0);
    expect(controlPlane.finishedRuns[0]?.status).toBe("succeeded");
    expect(controlPlane.finishedRuns[0]?.costUsd).toBe(0.12);
    expect(controlPlane.finishedRuns[0]?.tokensInput).toBe(100);
    expect(controlPlane.finishedRuns[0]?.tokensOutput).toBe(25);
    expect(claude.brief).toContain("## Intent\nAdd the mock runner smoke marker");
    expect(claude.brief).toContain(`- work_order_id: ${workOrder.id}`);
    expect(controlPlane.audits.map((a) => a.eventType)).toContain("agent_dispatched");
    expect(controlPlane.audits.map((a) => a.eventType)).toContain("agent_finished");
    expect(existsSync(join(root, workOrder.id))).toBe(false);
  });

  test("marks the work order and agent run failed when Claude Code fails", async () => {
    const { deps, controlPlane, root } = await makeDeps(new FailingClaude());
    const workOrder = sampleWorkOrder();

    const result = await executeWorkOrder(workOrder, deps, { runnerId: "mac-studio-1", leaseSeconds: 600 });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Claude Code exploded");
    expect(controlPlane.failed[0]?.workOrderId).toBe(workOrder.id);
    expect(controlPlane.failed[0]?.runnerId).toBe("mac-studio-1");
    expect(controlPlane.finishedRuns[0]?.status).toBe("failed");
    expect(controlPlane.audits.map((a) => a.eventType)).toContain("agent_failed");
    expect(existsSync(join(root, workOrder.id))).toBe(false);
  });
});
