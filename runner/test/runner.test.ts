import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockWorkspaceManager } from "../src/workspace";
import { executeExtractionTask, executeWorkOrder, notifyTelegramWithRetry, parseExtractionOutput, sweepOrphanWorkspaces, type RunnerDeps } from "../src/runner";
import { MockGitHubApp } from "../src/githubApp";
import type { AgentRun, ControlPlane, ExtractionTask, FinishRunInput, RewriteTask, UsageUpdate, WorkOrder } from "../src/controlPlane";
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
  extractionAnswered: Array<{ sendId: string; optionId: string }> = [];
  extractionClarified: Array<{ sendId: string; question: string }> = [];
  extractionReview: Array<{ sendId: string; reason: string }> = [];
  extractionFailed: Array<{ sendId: string; error: string }> = [];
  completed: Array<{ workOrderId: string; prUrl: string }> = [];
  failed: Array<{ workOrderId: string; runnerId: string; error: string }> = [];
  finishedRuns: FinishRunInput[] = [];
  heartbeats = 0;
  audits: Array<{ eventType: string; actor: string }> = [];
  runningAgentWorkOrderIds: string[] = [];

  async claimWorkOrder(): Promise<WorkOrder | null> { return null; }
  async claimRewriteTask(): Promise<RewriteTask | null> { return null; }
  async finishRewriteTask(): Promise<RewriteTask> { throw new Error('not implemented in test fake'); }
  async failRewriteTask(): Promise<RewriteTask> { throw new Error('not implemented in test fake'); }
  async claimExtractionTask(): Promise<ExtractionTask | null> { return null; }
  async finishExtractionWithAnswer(sendId: string, _runnerId: string, _claimToken: string, optionId: string): Promise<unknown> { this.extractionAnswered.push({ sendId, optionId }); return {}; }
  async finishExtractionWithClarify(sendId: string, _runnerId: string, _claimToken: string, clarifyingQuestion: string): Promise<ExtractionTask> { this.extractionClarified.push({ sendId, question: clarifyingQuestion }); return sampleExtractionTask(); }
  async finishExtractionNeedsReview(sendId: string, _runnerId: string, _claimToken: string, _llmExtraction: unknown, reason: string): Promise<ExtractionTask> { this.extractionReview.push({ sendId, reason }); return sampleExtractionTask(); }
  async failExtractionTask(sendId: string, _runnerId: string, _claimToken: string, error: string): Promise<ExtractionTask> { this.extractionFailed.push({ sendId, error }); return sampleExtractionTask(); }
  async renewLease(): Promise<WorkOrder | null> { this.heartbeats += 1; return sampleWorkOrder(); }
  async completeWorkOrder(workOrderId: string, prUrl: string): Promise<WorkOrder> {
    this.completed.push({ workOrderId, prUrl });
    return sampleWorkOrder({ status: "pr_open", pr_url: prUrl });
  }
  async failWorkOrder(workOrderId: string, runnerId: string, error: string): Promise<WorkOrder> {
    this.failed.push({ workOrderId, runnerId, error });
    return sampleWorkOrder({ status: "failed" });
  }
  async listRunningAgentWorkOrderIds(): Promise<string[]> { return this.runningAgentWorkOrderIds; }
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
  promptOutput = "{}";
  async runPrompt(_input: ClaudePromptInput): Promise<ClaudeGoalResult> {
    return { exitCode: 0, stdout: this.promptOutput, stderr: "", costUsd: 0, tokensInput: 0, tokensOutput: 0 };
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

function sampleExtractionTask(overrides: Partial<ExtractionTask> = {}): ExtractionTask {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    app_id: "22222222-2222-4222-8222-222222222222",
    issue_id: "44444444-4444-4444-8444-444444444444",
    decision_external_ref: "Q10",
    raw_decision_title: "Rebate stacking rules",
    raw_decision_body: null,
    rewritten_subject: "Quick question",
    rewritten_body: "Which option should we use?",
    options_snapshot: [{ id: "pick_one", label: "Pick one" }, { id: "stack", label: "Stack" }],
    raw_reply_text: "pick one",
    recipient_email: "rylee@qep.com",
    recipient_name: "Rylee",
    claim_token: "55555555-5555-4555-8555-555555555555",
    clarification_attempt_count: 0,
    attempt_count: 1,
    max_attempts: 3,
    risk_class: "authorize",
    ...overrides,
  };
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

describe("sweepOrphanWorkspaces", () => {
  test("deletes non-running workspace directories and preserves running runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-runner-sweep-test-"));
    tempRoots.push(root);
    await mkdir(join(root, "running-wo"));
    await mkdir(join(root, "finished-wo"));
    await mkdir(join(root, "no-agent-run"));
    const controlPlane = new FakeControlPlane();
    controlPlane.runningAgentWorkOrderIds = ["running-wo"];

    await sweepOrphanWorkspaces({ controlPlane, logger: createLogger("runner-test") }, root);
    await sweepOrphanWorkspaces({ controlPlane, logger: createLogger("runner-test") }, root);

    expect(existsSync(join(root, "running-wo"))).toBe(true);
    expect(existsSync(join(root, "finished-wo"))).toBe(false);
    expect(existsSync(join(root, "no-agent-run"))).toBe(false);
  });
});

describe("notifyTelegramWithRetry", () => {
  const payload = {
    event_type: "work_order_pr_opened" as const,
    severity: "normal" as const,
    title: "PR ready for review",
    body: "Body",
  };

  test("succeeds on the second bounded retry", async () => {
    const sleeps: number[] = [];
    let attempts = 0;

    await notifyTelegramWithRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient Telegram failure");
    }, payload, async (ms) => {
      sleeps.push(ms);
    });

    expect(attempts).toBe(3);
    expect(sleeps).toEqual([250, 1000]);
  });

  test("stops before retrying non-retryable HTTP 4xx failures", async () => {
    let attempts = 0;

    await expect(notifyTelegramWithRetry(async () => {
      attempts += 1;
      throw new Error("cc-telegram-notify returned HTTP 401: unauthorized");
    }, payload, async () => {
      throw new Error("should not sleep for non-retryable failures");
    })).rejects.toThrow("HTTP 401");

    expect(attempts).toBe(1);
  });
});

describe("parseExtractionOutput", () => {
  test("parses valid payload", () => {
    const parsed = parseExtractionOutput('{"matched_option_id":"pick_one","confidence":0.91,"rationale":"clear","ask_clarifying_question":null,"signals":{"explicit_option_mention":true,"explicit_accept_decline":false,"multi_option_mention":false,"off_topic":false,"hedging_language":false}}', sampleExtractionTask());
    expect(parsed.matched_option_id).toBe("pick_one");
    expect(parsed.confidence).toBe(0.91);
  });

  test("handles malformed values and clamps confidence", () => {
    const parsed = parseExtractionOutput('{"matched_option_id":"pick_one","confidence":7,"rationale":123,"ask_clarifying_question":"","signals":{}}', sampleExtractionTask());
    expect(parsed.confidence).toBe(1);
    expect(parsed.rationale).toBe("");
  });

  test("downgrades hallucinated option", () => {
    const parsed = parseExtractionOutput('{"matched_option_id":"hallucinated","confidence":0.9,"rationale":"x","ask_clarifying_question":"?","signals":{"off_topic":false}}', sampleExtractionTask());
    expect(parsed.matched_option_id).toBeNull();
    expect(parsed._hallucinated_option).toBe(true);
  });
});

describe("executeExtractionTask", () => {
  test("routes high confidence to finishExtractionWithAnswer", async () => {
    const cp = new FakeControlPlane();
    const claude = new RecordingClaude();
    claude.promptOutput = '{"matched_option_id":"pick_one","confidence":1,"rationale":"clear","ask_clarifying_question":null,"signals":{"explicit_option_mention":true,"explicit_accept_decline":false,"multi_option_mention":false,"off_topic":false,"hedging_language":false}}';
    const result = await executeExtractionTask(sampleExtractionTask(), { controlPlane: cp, claudeCode: claude, logger: createLogger("runner-test") }, { runnerId: "mac", extractionAutoCommitConfidence: 0.85, extractionOffTopicFloor: 0.2 });
    expect(result.status).toBe("succeeded");
    expect(cp.extractionAnswered[0]?.optionId).toBe("pick_one");
  });

  test("routes low confidence with budget to clarify", async () => {
    const cp = new FakeControlPlane();
    const claude = new RecordingClaude();
    claude.promptOutput = '{"matched_option_id":null,"confidence":0.5,"rationale":"ambiguous","ask_clarifying_question":"Which one?","signals":{"explicit_option_mention":false,"explicit_accept_decline":false,"multi_option_mention":false,"off_topic":false,"hedging_language":false}}';
    await executeExtractionTask(sampleExtractionTask(), { controlPlane: cp, claudeCode: claude, logger: createLogger("runner-test") }, { runnerId: "mac", extractionAutoCommitConfidence: 1.01, extractionOffTopicFloor: 0.2 });
    expect(cp.extractionClarified[0]?.sendId).toBeDefined();
  });

  test("routes exhausted budget to needs review", async () => {
    const cp = new FakeControlPlane();
    const claude = new RecordingClaude();
    claude.promptOutput = '{"matched_option_id":null,"confidence":0.5,"rationale":"ambiguous","ask_clarifying_question":"Which one?","signals":{"explicit_option_mention":false,"explicit_accept_decline":false,"multi_option_mention":false,"off_topic":false,"hedging_language":false}}';
    await executeExtractionTask(sampleExtractionTask({ clarification_attempt_count: 1 }), { controlPlane: cp, claudeCode: claude, logger: createLogger("runner-test") }, { runnerId: "mac", extractionAutoCommitConfidence: 1.01, extractionOffTopicFloor: 0.2 });
    expect(cp.extractionReview[0]?.reason).toBe("budget_exhausted");
  });

  test("routes off-topic to needs review", async () => {
    const cp = new FakeControlPlane();
    const claude = new RecordingClaude();
    claude.promptOutput = '{"matched_option_id":null,"confidence":0.1,"rationale":"thanks","ask_clarifying_question":null,"signals":{"explicit_option_mention":false,"explicit_accept_decline":false,"multi_option_mention":false,"off_topic":true,"hedging_language":false}}';
    await executeExtractionTask(sampleExtractionTask(), { controlPlane: cp, claudeCode: claude, logger: createLogger("runner-test") }, { runnerId: "mac", extractionAutoCommitConfidence: 1.01, extractionOffTopicFloor: 0.2 });
    expect(cp.extractionReview[0]?.reason).toBe("off_topic");
  });
});
