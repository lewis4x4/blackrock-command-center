import { errorSummary } from "./log";

export type WorkOrder = {
  id: string;
  app_id: string;
  target_repo: string;
  target_branch: string;
  change_spec: Record<string, unknown>;
  source_answer_id: string | null;
  risk_class: "auto" | "authorize" | "destructive" | "production";
  idempotency_key: string;
  cost_cap_usd: number | string | null;
  status: string;
  claimed_by: string | null;
  attempt_count: number;
  max_attempts: number;
  pr_url: string | null;
};

export type RewriteTask = {
  id: string;
  app_id: string;
  issue_id: string;
  decision_external_ref: string;
  raw_decision_title: string;
  raw_decision_body: string | null;
  options_snapshot: unknown;
  attempt_count: number;
  max_attempts: number;
};

export type ExtractionTask = {
  id: string;
  app_id: string;
  issue_id: string;
  decision_external_ref: string;
  raw_decision_title: string;
  raw_decision_body: string | null;
  rewritten_subject: string | null;
  rewritten_body: string | null;
  options_snapshot: unknown;
  raw_reply_text: string;
  recipient_email: string;
  recipient_name: string | null;
  claim_token: string;
  clarification_attempt_count: number;
  attempt_count: number;
  max_attempts: number;
  risk_class: "auto" | "authorize" | "destructive" | "production";
};

export type AgentRunStatus = "running" | "succeeded" | "failed" | "timed_out" | "cancelled";

export type AgentRun = {
  id: string;
  work_order_id: string;
  runner: string;
  started_at: string;
  finished_at: string | null;
  heartbeat_at: string | null;
  status: AgentRunStatus;
  cost_usd: number | string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  pr_url: string | null;
  notes: string | null;
};

export type UsageUpdate = {
  costUsd?: number | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
};

export type FinishRunInput = UsageUpdate & {
  status: Exclude<AgentRunStatus, "running">;
  prUrl?: string | null;
  notes?: string | null;
};

export interface ControlPlane {
  claimWorkOrder(runnerId: string, leaseSeconds: number): Promise<WorkOrder | null>;
  renewLease(workOrderId: string, runnerId: string, leaseSeconds: number): Promise<WorkOrder | null>;
  completeWorkOrder(workOrderId: string, prUrl: string): Promise<WorkOrder>;
  failWorkOrder(workOrderId: string, runnerId: string, error: string): Promise<WorkOrder>;
  createAgentRun(workOrderId: string, runner: string): Promise<AgentRun>;
  heartbeatAgentRun(runId: string, usage?: UsageUpdate): Promise<AgentRun>;
  finishAgentRun(runId: string, input: FinishRunInput): Promise<AgentRun>;
  getGitHubInstallationId(appId: string): Promise<string | null>;
  writeAuditEvent(appId: string | null, actor: string, eventType: string, detail: Record<string, unknown>): Promise<void>;
  claimRewriteTask(runnerId: string, leaseSeconds: number): Promise<RewriteTask | null>;
  finishRewriteTask(sendId: string, runnerId: string, subject: string, body: string, options: unknown): Promise<RewriteTask>;
  failRewriteTask(sendId: string, runnerId: string, error: string): Promise<RewriteTask>;
  claimExtractionTask(runnerId: string, leaseSeconds: number): Promise<ExtractionTask | null>;
  finishExtractionWithAnswer(sendId: string, runnerId: string, claimToken: string, optionId: string, confidence: number, rationale: string, llmExtraction: unknown): Promise<unknown>;
  finishExtractionWithClarify(sendId: string, runnerId: string, claimToken: string, clarifyingQuestion: string, confidence: number, llmExtraction: unknown): Promise<ExtractionTask>;
  finishExtractionNeedsReview(sendId: string, runnerId: string, claimToken: string, llmExtraction: unknown, reason: string): Promise<ExtractionTask>;
  failExtractionTask(sendId: string, runnerId: string, claimToken: string, error: string): Promise<ExtractionTask>;
}

export class ControlPlaneHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ControlPlaneHttpError";
  }
}

export class SupabaseControlPlane implements ControlPlane {
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    serviceRoleKey: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
    this.headers = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json; charset=utf-8",
    };
  }

  async claimWorkOrder(runnerId: string, leaseSeconds: number): Promise<WorkOrder | null> {
    const row = await this.rpc<unknown>("cc_claim_work_order", {
      p_runner: runnerId,
      p_lease_seconds: leaseSeconds,
    });
    return asWorkOrderOrNull(row);
  }

  async renewLease(workOrderId: string, runnerId: string, leaseSeconds: number): Promise<WorkOrder | null> {
    try {
      const row = await this.rpc<unknown>("cc_renew_lease", {
        p_work_order_id: workOrderId,
        p_runner: runnerId,
        p_lease_seconds: leaseSeconds,
      });
      return asWorkOrderOrNull(row);
    } catch (error) {
      if (error instanceof ControlPlaneHttpError && error.status >= 400 && error.status < 500) return null;
      throw error;
    }
  }

  async completeWorkOrder(workOrderId: string, prUrl: string): Promise<WorkOrder> {
    return await this.rpc<WorkOrder>("cc_complete_work_order", {
      p_work_order_id: workOrderId,
      p_pr_url: prUrl,
    });
  }

  async failWorkOrder(workOrderId: string, runnerId: string, error: string): Promise<WorkOrder> {
    return await this.rpc<WorkOrder>("cc_fail_work_order", {
      p_work_order_id: workOrderId,
      p_runner: runnerId,
      p_error: error.slice(0, 2000),
    });
  }

  async createAgentRun(workOrderId: string, runner: string): Promise<AgentRun> {
    const rows = await this.rest<AgentRun[]>("/rest/v1/agent_runs", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        work_order_id: workOrderId,
        runner,
        status: "running",
        heartbeat_at: new Date().toISOString(),
      }),
    });
    const row = rows[0];
    if (!row) throw new Error("agent_runs insert returned no rows");
    return row;
  }

  async heartbeatAgentRun(runId: string, usage: UsageUpdate = {}): Promise<AgentRun> {
    return await this.updateAgentRun(runId, {
      heartbeat_at: new Date().toISOString(),
      cost_usd: usage.costUsd,
      tokens_input: usage.tokensInput,
      tokens_output: usage.tokensOutput,
    });
  }

  async finishAgentRun(runId: string, input: FinishRunInput): Promise<AgentRun> {
    return await this.updateAgentRun(runId, {
      status: input.status,
      finished_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      cost_usd: input.costUsd,
      tokens_input: input.tokensInput,
      tokens_output: input.tokensOutput,
      pr_url: input.prUrl,
      notes: input.notes,
    });
  }

  async getGitHubInstallationId(appId: string): Promise<string | null> {
    const query = new URLSearchParams({
      app_id: `eq.${appId}`,
      select: "github_install_id",
      limit: "1",
    });
    const rows = await this.rest<Array<{ github_install_id: string | null }>>(`/rest/v1/registry_app_repo?${query.toString()}`);
    const installId = rows[0]?.github_install_id?.trim();
    return installId || null;
  }

  async writeAuditEvent(appId: string | null, actor: string, eventType: string, detail: Record<string, unknown>): Promise<void> {
    await this.rest<unknown>("/rest/v1/cc_audit_events", {
      method: "POST",
      body: JSON.stringify({ app_id: appId, actor, event_type: eventType, detail }),
    });
  }

  async claimRewriteTask(runnerId: string, leaseSeconds: number): Promise<RewriteTask | null> {
    const row = await this.rpc<unknown>("cc_claim_rewrite_task", { p_runner: runnerId, p_lease_seconds: leaseSeconds });
    return asRewriteTaskOrNull(row);
  }

  async finishRewriteTask(sendId: string, runnerId: string, subject: string, body: string, options: unknown): Promise<RewriteTask> {
    return await this.rpc<RewriteTask>("cc_finish_rewrite_task", {
      p_send_id: sendId,
      p_runner: runnerId,
      p_rewritten_subject: subject,
      p_rewritten_body: body,
      p_options_snapshot: options,
    });
  }

  async failRewriteTask(sendId: string, runnerId: string, error: string): Promise<RewriteTask> {
    return await this.rpc<RewriteTask>("cc_fail_rewrite_task", {
      p_send_id: sendId,
      p_runner: runnerId,
      p_error: error.slice(0, 2000),
    });
  }

  async claimExtractionTask(runnerId: string, leaseSeconds: number): Promise<ExtractionTask | null> {
    const row = await this.rpc<unknown>("cc_claim_extraction_task", { p_runner: runnerId, p_lease_seconds: leaseSeconds });
    return asExtractionTaskOrNull(row);
  }

  async finishExtractionWithAnswer(sendId: string, runnerId: string, claimToken: string, optionId: string, confidence: number, rationale: string, llmExtraction: unknown): Promise<unknown> {
    return await this.rpc<unknown>("cc_finish_extraction_with_answer", {
      p_send_id: sendId,
      p_runner: runnerId,
      p_claim_token: claimToken,
      p_option_id: optionId,
      p_confidence: confidence,
      p_rationale: rationale,
      p_llm_extraction: llmExtraction,
    });
  }

  async finishExtractionWithClarify(sendId: string, runnerId: string, claimToken: string, clarifyingQuestion: string, confidence: number, llmExtraction: unknown): Promise<ExtractionTask> {
    return await this.rpc<ExtractionTask>("cc_finish_extraction_with_clarify", {
      p_send_id: sendId,
      p_runner: runnerId,
      p_claim_token: claimToken,
      p_clarifying_question: clarifyingQuestion,
      p_confidence: confidence,
      p_llm_extraction: llmExtraction,
    });
  }

  async finishExtractionNeedsReview(sendId: string, runnerId: string, claimToken: string, llmExtraction: unknown, reason: string): Promise<ExtractionTask> {
    return await this.rpc<ExtractionTask>("cc_finish_extraction_needs_review", {
      p_send_id: sendId,
      p_runner: runnerId,
      p_claim_token: claimToken,
      p_llm_extraction: llmExtraction,
      p_reason: reason,
    });
  }

  async failExtractionTask(sendId: string, runnerId: string, claimToken: string, error: string): Promise<ExtractionTask> {
    return await this.rpc<ExtractionTask>("cc_fail_extraction_task", {
      p_send_id: sendId,
      p_runner: runnerId,
      p_claim_token: claimToken,
      p_error: error.slice(0, 2000),
    });
  }

  private async updateAgentRun(runId: string, input: Record<string, unknown>): Promise<AgentRun> {
    const payload = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    const rows = await this.rest<AgentRun[]>(`/rest/v1/agent_runs?id=eq.${encodeURIComponent(runId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(payload),
    });
    const row = rows[0];
    if (!row) throw new Error(`agent_runs update returned no rows for ${runId}`);
    return row;
  }

  private async rpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
    return await this.rest<T>(`/rest/v1/rpc/${name}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  private async rest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.headers,
        ...(init.headers as Record<string, string> | undefined),
      },
    });

    const text = await response.text();
    if (!response.ok) {
      throw new ControlPlaneHttpError(`control-plane ${init.method ?? "GET"} ${path} -> ${response.status}: ${text}`, response.status, text);
    }
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(`control-plane returned non-JSON for ${path}: ${errorSummary(error)}`);
    }
  }
}

function asWorkOrderOrNull(value: unknown): WorkOrder | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<WorkOrder>;
  if (typeof row.id !== "string" || !row.id) return null;
  return row as WorkOrder;
}

function asRewriteTaskOrNull(value: unknown): RewriteTask | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<RewriteTask>;
  if (typeof row.id !== "string" || !row.id) return null;
  return row as RewriteTask;
}

function asExtractionTaskOrNull(value: unknown): ExtractionTask | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<ExtractionTask>;
  if (typeof row.id !== "string" || !row.id) return null;
  if (typeof row.claim_token !== "string" || !row.claim_token) return null;
  return row as ExtractionTask;
}
