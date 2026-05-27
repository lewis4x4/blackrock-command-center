import type { ClaudeCodeRunner, ClaudeGoalResult } from "./claudeCode";
import type { ControlPlane, ExtractionTask, RewriteTask, WorkOrder } from "./controlPlane";
import type { GitHubPullRequestClient, GitHubTokenProvider } from "./githubApp";
import type { Logger } from "./log";
import type { WorkspaceManager, Workspace } from "./workspace";
import { compactError, runNotes, RUNNER_ADAPTER, safeAudit, usageFromClaude } from "./audit";

export type TelegramNotifyPayload = {
  event_type: "work_order_pr_opened";
  severity: "low" | "normal" | "high" | "critical";
  app_id?: string;
  title: string;
  body: string;
  deep_link?: string;
};

export type TelegramNotifier = (payload: TelegramNotifyPayload) => Promise<void>;

export type RunnerDeps = {
  controlPlane: ControlPlane;
  tokenProvider: GitHubTokenProvider;
  pullRequestClient: GitHubPullRequestClient;
  workspaceManager: WorkspaceManager;
  claudeCode: ClaudeCodeRunner;
  logger: Logger;
  telegramNotifier?: TelegramNotifier;
};

export type RunnerOptions = {
  runnerId: string;
  leaseSeconds: number;
  pollIntervalSeconds: number;
  extractionAutoCommitConfidence: number;
  extractionOffTopicFloor: number;
};

export type ExecuteResult = {
  status: "succeeded" | "failed";
  prUrl?: string;
  error?: string;
};

export class LeaseLostError extends Error {
  constructor(workOrderId: string) {
    super(`Lease renewal failed for work order ${workOrderId}; aborting local run.`);
    this.name = "LeaseLostError";
  }
}

export class RunnerDaemon {
  private stopping = false;
  private current: Promise<ExecuteResult> | null = null;

  constructor(private readonly deps: RunnerDeps, private readonly options: RunnerOptions) {}

  requestStop(): void {
    this.stopping = true;
    this.deps.logger.info("shutdown requested; daemon will finish current work order before exiting");
  }

  async runForever(): Promise<void> {
    this.deps.logger.info("runner daemon started", {
      runner_id: this.options.runnerId,
      poll_interval_seconds: this.options.pollIntervalSeconds,
      lease_seconds: this.options.leaseSeconds,
    });
    this.deps.logger.info("rewrite_decision poll loop started", {
      runner_id: this.options.runnerId,
      task_type: "rewrite_decision",
    });

    while (!this.stopping) {
      const workOrder = await this.deps.controlPlane.claimWorkOrder(this.options.runnerId, this.options.leaseSeconds);
      if (workOrder) {
        this.current = executeWorkOrder(workOrder, this.deps, this.options);
      } else {
        const rewriteTask = await this.deps.controlPlane.claimRewriteTask(this.options.runnerId, this.options.leaseSeconds);
        if (rewriteTask) {
          this.current = executeRewriteTask(rewriteTask, this.deps, this.options);
        } else {
          const extractionTask = await this.deps.controlPlane.claimExtractionTask(this.options.runnerId, this.options.leaseSeconds);
          this.current = extractionTask ? executeExtractionTask(extractionTask, this.deps, this.options) : null;
        }
      }
      if (!this.current) {
        await sleep(this.options.pollIntervalSeconds * 1000, () => this.stopping);
        continue;
      }

      try {
        await this.current;
      } finally {
        this.current = null;
      }
    }

    if (this.current) await this.current;
    this.deps.logger.info("runner daemon stopped");
  }
}

export async function executeRewriteTask(task: RewriteTask, deps: Pick<RunnerDeps, "controlPlane" | "claudeCode" | "logger">, options: Pick<RunnerOptions, "runnerId">): Promise<ExecuteResult> {
  const { controlPlane, claudeCode, logger } = deps;
  logger.info("rewrite_decision task claimed", {
    send_id: task.id,
    app_id: task.app_id,
    issue_id: task.issue_id,
    attempt_count: task.attempt_count,
  });
  try {
    const prompt = buildRewritePrompt(task);
    const result = await claudeCode.runPrompt({ prompt });
    const parsed = parseRewriteOutput(result.stdout);
    const fallbackOptions = normalizeRewriteOptions(task.options_snapshot);
    const rewrittenOptions = parsed.rewritten_options.length ? parsed.rewritten_options : fallbackOptions;
    await controlPlane.finishRewriteTask(task.id, options.runnerId, parsed.rewritten_subject, parsed.rewritten_body, rewrittenOptions);
    logger.info("rewrite_decision task completed", { send_id: task.id });
    return { status: "succeeded" };
  } catch (error) {
    const message = compactError(error);
    logger.error("rewrite_decision task failed", { send_id: task.id, error: message });
    try {
      await controlPlane.failRewriteTask(task.id, options.runnerId, message);
    } catch (failError) {
      logger.error("failed to mark rewrite_decision task failed", { send_id: task.id, error: compactError(failError) });
    }
    return { status: "failed", error: message };
  }
}

type RewriteOutput = {
  rewritten_subject: string;
  rewritten_body: string;
  rewritten_options: Array<{ id: string; label: string }>;
};

type ExtractionOutput = {
  matched_option_id: string | null;
  confidence: number;
  rationale: string;
  ask_clarifying_question: string | null;
  signals: {
    explicit_option_mention: boolean;
    explicit_accept_decline: boolean;
    multi_option_mention: boolean;
    off_topic: boolean;
    hedging_language: boolean;
  };
  _hallucinated_option?: boolean;
};

function buildRewritePrompt(task: RewriteTask): string {
  const inputOptions = normalizeRewriteOptions(task.options_snapshot);
  const hasOptions = inputOptions.length > 0;
  const optionsRule = hasOptions
    ? [
        "- Keep every option id exactly the same.",
        "- Rewrite option labels into plain English.",
      ]
    : [
        "- The raw decision has no enumerated options. Generate 2-4 plausible, mutually-exclusive options the recipient could pick to resolve the question.",
        "- Each generated option must have a short snake_case id (e.g. \"approve\", \"reject\", \"approve_with_changes\") and a plain-English label.",
        "- Do not invent facts; base options on the raw question only.",
      ];
  return [
    "You rewrite technical client decisions into friendly customer-facing email copy.",
    "Return ONLY valid JSON with keys: rewritten_subject, rewritten_body, rewritten_options.",
    "Rules:",
    "- Keep the meaning exactly the same.",
    ...optionsRule,
    "- Keep the body brief, polite, and natural from Brian Lewis.",
    "- Do not add facts not present in the raw decision.",
    "",
    JSON.stringify({
      decision_external_ref: task.decision_external_ref,
      raw_title: task.raw_decision_title,
      raw_body: task.raw_decision_body,
      options: inputOptions,
    }, null, 2),
  ].join("\n");
}

export async function executeExtractionTask(task: ExtractionTask, deps: Pick<RunnerDeps, "controlPlane" | "claudeCode" | "logger">, options: Pick<RunnerOptions, "runnerId" | "extractionAutoCommitConfidence" | "extractionOffTopicFloor">): Promise<ExecuteResult> {
  const { controlPlane, claudeCode, logger } = deps;
  logger.info("extraction task claimed", {
    send_id: task.id,
    app_id: task.app_id,
    issue_id: task.issue_id,
    attempt_count: task.attempt_count,
    claim_token: task.claim_token,
  });
  try {
    const prompt = buildExtractionPrompt(task, options.extractionAutoCommitConfidence);
    const result = await claudeCode.runPrompt({ prompt });
    const parsed = parseExtractionOutput(result.stdout, task);
    const outcome = decideExtractionOutcome(parsed, task, options.extractionAutoCommitConfidence, options.extractionOffTopicFloor);
    const llmExtraction = {
      ...parsed,
      model: "claude-cli",
      extracted_at: new Date().toISOString(),
      runner_id: options.runnerId,
      prompt_version: "slice2-v1",
    };

    if (outcome.kind === "answer") {
      await controlPlane.finishExtractionWithAnswer(task.id, options.runnerId, task.claim_token, outcome.option_id, parsed.confidence, parsed.rationale, llmExtraction);
      return { status: "succeeded" };
    }
    if (outcome.kind === "clarify") {
      await controlPlane.finishExtractionWithClarify(task.id, options.runnerId, task.claim_token, outcome.clarifying_question, parsed.confidence, llmExtraction);
      return { status: "succeeded" };
    }
    await controlPlane.finishExtractionNeedsReview(task.id, options.runnerId, task.claim_token, llmExtraction, outcome.reason);
    return { status: "succeeded" };
  } catch (error) {
    const message = compactError(error);
    logger.error("extraction task failed", { send_id: task.id, error: message });
    try {
      if (message.toLowerCase().includes("below auto-commit threshold")) {
        await controlPlane.finishExtractionNeedsReview(task.id, options.runnerId, task.claim_token, {
          matched_option_id: null,
          confidence: 0,
          rationale: "auto-commit threshold mismatch between runner env and DB GUC",
          ask_clarifying_question: null,
          signals: {
            explicit_option_mention: false,
            explicit_accept_decline: false,
            multi_option_mention: false,
            off_topic: false,
            hedging_language: false,
          },
          requires_human: true,
          reason: "low_confidence",
          model: "claude-cli",
          extracted_at: new Date().toISOString(),
          runner_id: options.runnerId,
          prompt_version: "slice2-v1",
        }, "low_confidence");
      } else {
        await controlPlane.failExtractionTask(task.id, options.runnerId, task.claim_token, message);
      }
    } catch (failError) {
      logger.error("failed to mark extraction task failed", { send_id: task.id, error: compactError(failError) });
    }
    return { status: "failed", error: message };
  }
}

function buildExtractionPrompt(task: ExtractionTask, highThreshold: number): string {
  const options = normalizeRewriteOptions(task.options_snapshot);
  return [
    "You extract a structured decision from a free-text email reply.",
    "",
    "Return ONLY valid JSON with these keys:",
    "  matched_option_id        string | null",
    "  confidence               number 0..1",
    "  rationale                string (<= 240 chars)",
    "  ask_clarifying_question  string | null  (<= 400 chars; required iff matched_option_id is null OR confidence < HIGH_THRESHOLD)",
    "  signals                  { explicit_option_mention: boolean, explicit_accept_decline: boolean, multi_option_mention: boolean, off_topic: boolean, hedging_language: boolean }",
    "",
    "Rules:",
    "- matched_option_id MUST be exactly one of the option ids listed below, or null.",
    "- Never invent new option ids. Never reorder. Never edit labels.",
    "- If the reply mentions multiple options positively, return matched_option_id=null and explain in rationale.",
    "- If the reply is off-topic, return matched_option_id=null and signals.off_topic=true. Confidence should be low.",
    "- If the reply asks a counter-question, return matched_option_id=null and propose a clarifying question.",
    "- Hedging language forces confidence below HIGH_THRESHOLD even if a single option is mentioned.",
    "",
    `HIGH_THRESHOLD is ${highThreshold.toFixed(2)}.`,
    "",
    JSON.stringify({
      decision_external_ref: task.decision_external_ref,
      raw_question_title: task.raw_decision_title,
      what_the_client_received: {
        subject: task.rewritten_subject,
        body: task.rewritten_body,
      },
      options,
      client_reply: task.raw_reply_text,
    }, null, 2),
  ].join("\n");
}

export function parseExtractionOutput(stdout: string, task: Pick<ExtractionTask, "options_snapshot">): ExtractionOutput {
  const jsonText = extractJsonObject(stdout);
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  const options = normalizeRewriteOptions(task.options_snapshot);
  const optionIds = new Set(options.map((opt) => opt.id));
  const rawMatched = stringValue(parsed.matched_option_id);
  const hallucinated = !!rawMatched && !optionIds.has(rawMatched);
  const matched = rawMatched && optionIds.has(rawMatched) ? rawMatched : null;
  const confidence = clamp01(asNumber(parsed.confidence) ?? 0);
  const rationale = (stringValue(parsed.rationale) ?? "").slice(0, 500);
  const ask = (stringValue(parsed.ask_clarifying_question) ?? "").slice(0, 400) || null;
  const signalsRaw = parsed.signals && typeof parsed.signals === "object" ? parsed.signals as Record<string, unknown> : {};
  return {
    matched_option_id: matched,
    confidence,
    rationale,
    ask_clarifying_question: ask,
    signals: {
      explicit_option_mention: signalsRaw.explicit_option_mention === true,
      explicit_accept_decline: signalsRaw.explicit_accept_decline === true,
      multi_option_mention: signalsRaw.multi_option_mention === true,
      off_topic: signalsRaw.off_topic === true,
      hedging_language: signalsRaw.hedging_language === true,
    },
    _hallucinated_option: hallucinated,
  };
}

function decideExtractionOutcome(parsed: ExtractionOutput, task: Pick<ExtractionTask, "clarification_attempt_count">, autoCommitThreshold: number, offTopicFloor: number):
  | { kind: "answer"; option_id: string }
  | { kind: "clarify"; clarifying_question: string }
  | { kind: "needs_review"; reason: "off_topic" | "unparseable" | "option_hallucinated" | "budget_exhausted" | "low_confidence" } {
  const hasQuestion = !!parsed.ask_clarifying_question?.trim();
  if (parsed.signals.off_topic || parsed.confidence <= offTopicFloor) {
    return { kind: "needs_review", reason: parsed.signals.off_topic ? "off_topic" : "unparseable" };
  }
  if (parsed._hallucinated_option) {
    return { kind: "needs_review", reason: "option_hallucinated" };
  }
  if (!parsed.matched_option_id && !hasQuestion) {
    return { kind: "needs_review", reason: "unparseable" };
  }
  if (parsed.matched_option_id && parsed.confidence >= autoCommitThreshold && !parsed.signals.multi_option_mention && !parsed.signals.hedging_language && !parsed.signals.off_topic) {
    return { kind: "answer", option_id: parsed.matched_option_id };
  }
  if (task.clarification_attempt_count < 1 && !parsed.signals.off_topic) {
    return { kind: "clarify", clarifying_question: parsed.ask_clarifying_question || "Just to confirm, which option should I move forward with?" };
  }
  return { kind: "needs_review", reason: task.clarification_attempt_count >= 1 ? "budget_exhausted" : "low_confidence" };
}

function parseRewriteOutput(stdout: string): RewriteOutput {
  const jsonText = extractJsonObject(stdout);
  const parsed = JSON.parse(jsonText) as Partial<RewriteOutput>;
  const subject = typeof parsed.rewritten_subject === "string" ? parsed.rewritten_subject.trim() : "";
  const body = typeof parsed.rewritten_body === "string" ? parsed.rewritten_body.trim() : "";
  if (!subject || !body) throw new Error("Claude rewrite output missing rewritten_subject or rewritten_body");
  return {
    rewritten_subject: subject.slice(0, 300),
    rewritten_body: body.slice(0, 8000),
    rewritten_options: normalizeRewriteOptions(parsed.rewritten_options),
  };
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Claude rewrite output did not contain a JSON object");
  return source.slice(start, end + 1);
}

function normalizeRewriteOptions(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string" && item.trim()) return { id: item.trim(), label: item.trim() };
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const rec = item as Record<string, unknown>;
    const id = stringValue(rec.id) ?? stringValue(rec.value) ?? stringValue(rec.key);
    if (!id) return null;
    return { id, label: stringValue(rec.label) ?? stringValue(rec.name) ?? stringValue(rec.title) ?? id };
  }).filter((item): item is { id: string; label: string } => !!item);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export async function executeWorkOrder(workOrder: WorkOrder, deps: RunnerDeps, options: Pick<RunnerOptions, "runnerId" | "leaseSeconds">): Promise<ExecuteResult> {
  const { controlPlane, tokenProvider, pullRequestClient, workspaceManager, claudeCode, logger } = deps;
  let workspace: Workspace | null = null;
  let runId: string | null = null;
  let claudeResult: ClaudeGoalResult | null = null;
  let leaseMonitor: LeaseMonitor | null = null;
  let prUrl: string | null = null;
  let completed = false;

  logger.info("work order claimed", {
    work_order_id: workOrder.id,
    app_id: workOrder.app_id,
    target_repo: workOrder.target_repo,
    target_branch: workOrder.target_branch,
    risk_class: workOrder.risk_class,
    attempt_count: workOrder.attempt_count,
  });

  try {
    const [runResult, installationIdResult, workspaceResult] = await Promise.allSettled([
      controlPlane.createAgentRun(workOrder.id, RUNNER_ADAPTER),
      controlPlane.getGitHubInstallationId(workOrder.app_id),
      workspaceManager.create(workOrder.id),
    ]);
    if (workspaceResult.status === "fulfilled") workspace = workspaceResult.value;
    if (runResult.status === "fulfilled") runId = runResult.value.id;
    if (runResult.status === "rejected") throw runResult.reason;
    if (installationIdResult.status === "rejected") throw installationIdResult.reason;
    if (workspaceResult.status === "rejected") throw workspaceResult.reason;
    if (!workspace) throw new Error("workspace creation returned no workspace");
    const installationId = installationIdResult.value;
    leaseMonitor = new LeaseMonitor({
      controlPlane,
      workOrderId: workOrder.id,
      runnerId: options.runnerId,
      leaseSeconds: options.leaseSeconds,
      runId,
      logger,
    });
    leaseMonitor.start();

    leaseMonitor.assertActive();
    const installationToken = await tokenProvider.mintInstallationToken(workOrder.target_repo, installationId);
    logger.info("minted GitHub installation token", {
      work_order_id: workOrder.id,
      target_repo: workOrder.target_repo,
      installation_id: installationToken.installationId,
      expires_at: installationToken.expiresAt,
    });

    leaseMonitor.assertActive();
    await workspaceManager.cloneRepository(workspace, workOrder.target_repo, workOrder.target_branch, installationToken.token);

    leaseMonitor.assertActive();
    const branchName = branchNameFor(workOrder);
    await workspaceManager.checkoutBranch(workspace, branchName);

    const brief = buildGoalBrief(workOrder, branchName);
    const briefPath = await workspaceManager.writeBrief(workspace, brief);

    await safeAudit(controlPlane, workOrder.app_id, options.runnerId, "agent_dispatched", {
      work_order_id: workOrder.id,
      runner: RUNNER_ADAPTER,
      branch: branchName,
    });

    leaseMonitor.assertActive();
    claudeResult = await claudeCode.runGoal({
      workspacePath: workspace.repoPath,
      briefPath,
      costCapUsd: numericOrNull(workOrder.cost_cap_usd),
      signal: leaseMonitor.signal,
    });

    leaseMonitor.assertActive();
    await workspaceManager.pushBranch(workspace, branchName, installationToken.token, workOrder.target_repo);

    leaseMonitor.assertActive();
    prUrl = await pullRequestClient.openPullRequest({
      targetRepo: workOrder.target_repo,
      headBranch: branchName,
      baseBranch: workOrder.target_branch,
      title: prTitle(workOrder),
      body: prBody(workOrder, branchName, claudeResult),
      token: installationToken.token,
    });

    leaseMonitor.assertActive();
    await retryCompleteWorkOrder(controlPlane, workOrder.id, prUrl, leaseMonitor);
    completed = true;
    leaseMonitor.stop();

    if (runId) {
      try {
        await controlPlane.finishAgentRun(runId, {
          status: "succeeded",
          prUrl,
          notes: runNotes(["Claude Code /goal completed and runner opened a PR.", summarizeProcessOutput(claudeResult)]),
          ...usageFromClaude(claudeResult),
        });
      } catch (finishError) {
        logger.error("failed to finish succeeded agent run", { work_order_id: workOrder.id, run_id: runId, error: compactError(finishError) });
      }
    }
    await safeAudit(controlPlane, workOrder.app_id, options.runnerId, "agent_finished", {
      work_order_id: workOrder.id,
      pr_url: prUrl,
      runner: RUNNER_ADAPTER,
    });
    await notifyPrOpened(deps, options.runnerId, workOrder, prUrl);

    logger.info("work order completed", { work_order_id: workOrder.id, pr_url: prUrl });
    return { status: "succeeded", prUrl };
  } catch (error) {
    leaseMonitor?.stop();
    const message = compactError(error);
    logger.error("work order failed", { work_order_id: workOrder.id, error: message, pr_url: prUrl });

    if (!prUrl && !completed) {
      try {
        await controlPlane.failWorkOrder(workOrder.id, options.runnerId, message);
      } catch (failError) {
        logger.error("failed to mark work order failed", { work_order_id: workOrder.id, error: compactError(failError) });
      }
    } else {
      logger.error("PR already opened; not failing work order to avoid duplicate runner retry", { work_order_id: workOrder.id, pr_url: prUrl });
    }

    if (runId) {
      try {
        await controlPlane.finishAgentRun(runId, {
          status: error instanceof LeaseLostError ? "cancelled" : "failed",
          prUrl,
          notes: runNotes([message, prUrl ? `PR was already opened: ${prUrl}` : null, claudeResult ? summarizeProcessOutput(claudeResult) : null]),
          ...(claudeResult ? usageFromClaude(claudeResult) : {}),
        });
      } catch (finishError) {
        logger.error("failed to finish agent run", { work_order_id: workOrder.id, run_id: runId, error: compactError(finishError) });
      }
    }

    await safeAudit(controlPlane, workOrder.app_id, options.runnerId, "agent_failed", {
      work_order_id: workOrder.id,
      runner: RUNNER_ADAPTER,
      error: message,
      pr_url: prUrl,
    });

    return { status: "failed", error: message };
  } finally {
    leaseMonitor?.stop();
    if (workspace) {
      try {
        await workspaceManager.destroy(workspace);
      } catch (destroyError) {
        logger.error("workspace cleanup failed", { work_order_id: workOrder.id, error: compactError(destroyError) });
      }
    }
  }
}

class LeaseMonitor {
  private controller = new AbortController();
  private timer: ReturnType<typeof setInterval> | null = null;
  private leaseLost: LeaseLostError | null = null;
  private inFlight = false;

  constructor(private readonly input: {
    controlPlane: ControlPlane;
    workOrderId: string;
    runnerId: string;
    leaseSeconds: number;
    runId: string;
    logger: Logger;
  }) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(): void {
    const intervalMs = Math.max(1000, Math.floor((this.input.leaseSeconds * 1000) / 3));
    this.timer = setInterval(() => void this.renew(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  assertActive(): void {
    if (this.leaseLost) throw this.leaseLost;
  }

  private async renew(): Promise<void> {
    if (this.inFlight || this.leaseLost) return;
    this.inFlight = true;
    try {
      const renewed = await this.input.controlPlane.renewLease(this.input.workOrderId, this.input.runnerId, this.input.leaseSeconds);
      if (!renewed) {
        this.loseLease();
        return;
      }
      await this.input.controlPlane.heartbeatAgentRun(this.input.runId);
      this.input.logger.debug("renewed work order lease", { work_order_id: this.input.workOrderId });
    } catch (error) {
      this.input.logger.error("lease heartbeat failed", { work_order_id: this.input.workOrderId, error: compactError(error) });
      this.loseLease();
    } finally {
      this.inFlight = false;
    }
  }

  private loseLease(): void {
    this.leaseLost = new LeaseLostError(this.input.workOrderId);
    this.controller.abort();
  }
}

async function notifyPrOpened(deps: RunnerDeps, runnerId: string, workOrder: WorkOrder, prUrl: string): Promise<void> {
  if (!deps.telegramNotifier) return;
  try {
    await deps.telegramNotifier({
      event_type: "work_order_pr_opened",
      severity: "normal",
      app_id: workOrder.app_id,
      title: "PR ready for review",
      body: `Work order ${workOrder.id} opened a PR for ${workOrder.target_repo}.`,
      deep_link: prUrl,
    });
  } catch (error) {
    const message = compactError(error);
    deps.logger.error("telegram notification failed", { work_order_id: workOrder.id, error: message });
    await safeAudit(deps.controlPlane, workOrder.app_id, runnerId, "telegram_notify_failed", {
      work_order_id: workOrder.id,
      pr_url: prUrl,
      event_type: "work_order_pr_opened",
      error: message,
    });
  }
}

async function retryCompleteWorkOrder(controlPlane: ControlPlane, workOrderId: string, prUrl: string, leaseMonitor: LeaseMonitor): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    leaseMonitor.assertActive();
    try {
      await controlPlane.completeWorkOrder(workOrderId, prUrl);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function buildGoalBrief(workOrder: WorkOrder, branchName = branchNameFor(workOrder)): string {
  const spec = workOrder.change_spec ?? {};
  return [
    "# Command Center /goal work order",
    "",
    "## Intent",
    renderValue(spec.intent),
    "",
    "## Affected area",
    renderValue(spec.affected_area),
    "",
    "## Acceptance criteria",
    renderList(spec.acceptance_criteria),
    "",
    "## Constraints",
    renderList(spec.constraints),
    "",
    "## Safe provenance",
    `- work_order_id: ${workOrder.id}`,
    `- app_id: ${workOrder.app_id}`,
    `- source_answer_id: ${workOrder.source_answer_id ?? "none"}`,
    `- risk_class: ${workOrder.risk_class}`,
    `- target_repo: ${workOrder.target_repo}`,
    `- target_branch: ${workOrder.target_branch}`,
    `- working_branch: ${branchName}`,
    `- cost_cap_usd: ${workOrder.cost_cap_usd ?? "none"}`,
    "",
    "## Runner rules",
    "- Use only the structured fields above as instructions.",
    "- Do not merge the PR.",
    "- Do not open the PR. The runner opens it after you finish.",
    "- Do not push the branch. The runner pushes after you finish.",
    "- Keep changes focused on the requested acceptance criteria.",
    "- Run relevant tests/checks before finishing when available.",
    "",
  ].join("\n");
}

export function branchNameFor(workOrder: WorkOrder): string {
  const hint = typeof workOrder.change_spec?.branch_hint === "string" ? workOrder.change_spec.branch_hint : "";
  if (hint.trim()) return sanitizeBranchName(hint.trim());
  return `cc/${workOrder.id}`;
}

function sanitizeBranchName(raw: string): string {
  const cleaned = raw
    .replace(/^refs\/heads\//, "")
    .replace(/\.\./g, "-")
    .replace(/[~^:?*[\]\\\s]+/g, "-")
    .replace(/\/+$/g, "")
    .replace(/^\/+/, "")
    .slice(0, 120);
  return cleaned || "cc/work-order";
}

function renderValue(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value == null) return "Not specified.";
  return JSON.stringify(value, null, 2);
}

function renderList(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => `- ${renderValue(item).replace(/\n/g, "\n  ")}`);
    return items.length ? items.join("\n") : "- Not specified.";
  }
  if (typeof value === "string" && value.trim()) return `- ${value.trim()}`;
  if (value == null) return "- Not specified.";
  return `- ${JSON.stringify(value, null, 2)}`;
}

function prTitle(workOrder: WorkOrder): string {
  const intent = typeof workOrder.change_spec.intent === "string" ? workOrder.change_spec.intent.trim() : "Command Center work order";
  return intent.length > 80 ? `${intent.slice(0, 77)}...` : intent;
}

function prBody(workOrder: WorkOrder, branchName: string, result: ClaudeGoalResult): string {
  return [
    "Opened by the BlackRock Command Center runner.",
    "",
    `Work order: ${workOrder.id}`,
    `Runner: ${RUNNER_ADAPTER}`,
    `Branch: ${branchName}`,
    `Risk class: ${workOrder.risk_class}`,
    "",
    "## Acceptance criteria",
    renderList(workOrder.change_spec.acceptance_criteria),
    "",
    "## Runner output excerpt",
    fencedExcerpt(result.stdout || result.stderr || "Claude Code completed without output."),
  ].join("\n");
}

function fencedExcerpt(text: string): string {
  const excerpt = text.slice(0, 3000);
  return `\`\`\`\n${excerpt}\n\`\`\``;
}

function summarizeProcessOutput(result: ClaudeGoalResult): string {
  return runNotes([
    result.stdout ? `stdout:\n${result.stdout.slice(0, 3000)}` : null,
    result.stderr ? `stderr:\n${result.stderr.slice(0, 3000)}` : null,
  ]);
}

function numericOrNull(value: number | string | null): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function sleep(ms: number, shouldStop: () => boolean): Promise<void> {
  const step = 250;
  let waited = 0;
  while (waited < ms && !shouldStop()) {
    const duration = Math.min(step, ms - waited);
    await new Promise((resolve) => setTimeout(resolve, duration));
    waited += duration;
  }
}
