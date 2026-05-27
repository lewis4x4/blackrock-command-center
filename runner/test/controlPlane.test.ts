import { describe, expect, test } from "bun:test";
import { SupabaseControlPlane } from "../src/controlPlane";

type CapturedRequest = { url: string; init: RequestInit };

function makeFetch(responses: unknown[]) {
  const calls: CapturedRequest[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

describe("SupabaseControlPlane", () => {
  test("claim/renew/complete/fail use the expected RPC names and payloads", async () => {
    const row = { id: "wo-1", app_id: "app-1", target_repo: "o/r", target_branch: "main", change_spec: {}, source_answer_id: null, risk_class: "auto", idempotency_key: "k", cost_cap_usd: null, status: "claimed", claimed_by: "runner", attempt_count: 1, max_attempts: 3, pr_url: null };
    const { calls, fetchImpl } = makeFetch([row, row, { ...row, status: "pr_open" }, { ...row, status: "failed" }]);
    const cp = new SupabaseControlPlane("https://cp.example", "service-key", fetchImpl);

    await cp.claimWorkOrder("mac-studio-1", 600);
    await cp.renewLease("wo-1", "mac-studio-1", 600);
    await cp.completeWorkOrder("wo-1", "https://github.com/o/r/pull/1");
    await cp.failWorkOrder("wo-1", "mac-studio-1", "boom");

    expect(calls.map((c) => c.url)).toEqual([
      "https://cp.example/rest/v1/rpc/cc_claim_work_order",
      "https://cp.example/rest/v1/rpc/cc_renew_lease",
      "https://cp.example/rest/v1/rpc/cc_complete_work_order",
      "https://cp.example/rest/v1/rpc/cc_fail_work_order",
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ p_runner: "mac-studio-1", p_lease_seconds: 600 });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ p_work_order_id: "wo-1", p_runner: "mac-studio-1", p_lease_seconds: 600 });
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ p_work_order_id: "wo-1", p_pr_url: "https://github.com/o/r/pull/1" });
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({ p_work_order_id: "wo-1", p_runner: "mac-studio-1", p_error: "boom" });
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer service-key");
  });

  test("claim returns null when PostgREST encodes a NULL composite as an empty object", async () => {
    const { fetchImpl } = makeFetch([{}]);
    const cp = new SupabaseControlPlane("https://cp.example", "service-key", fetchImpl);

    await expect(cp.claimWorkOrder("mac-studio-1", 600)).resolves.toBeNull();
  });

  test("agent_runs insert, heartbeat, finish, and installation lookup use REST table shapes", async () => {
    const run = { id: "run-1", work_order_id: "wo-1", runner: "claude_code_goal", started_at: "now", finished_at: null, heartbeat_at: null, status: "running", cost_usd: null, tokens_input: null, tokens_output: null, pr_url: null, notes: null };
    const { calls, fetchImpl } = makeFetch([[run], [{ work_order_id: "wo-1" }, { work_order_id: "wo-1" }, { work_order_id: "wo-2" }], [{ ...run, heartbeat_at: "later" }], [{ ...run, status: "succeeded", pr_url: "pr" }], [{ github_install_id: "98765" }], []]);
    const cp = new SupabaseControlPlane("https://cp.example", "service-key", fetchImpl);

    await cp.createAgentRun("wo-1", "claude_code_goal");
    const runningWorkOrderIds = await cp.listRunningAgentWorkOrderIds();
    await cp.heartbeatAgentRun("run-1", { costUsd: 0.2, tokensInput: 11 });
    await cp.finishAgentRun("run-1", { status: "succeeded", prUrl: "pr", notes: "done", costUsd: 0.3, tokensOutput: 22 });
    const installId = await cp.getGitHubInstallationId("app-1");
    await cp.writeAuditEvent("app-1", "runner", "agent_dispatched", { work_order_id: "wo-1" });

    expect(calls[0]?.url).toBe("https://cp.example/rest/v1/agent_runs");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>).Prefer).toBe("return=representation");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ work_order_id: "wo-1", runner: "claude_code_goal", status: "running" });

    expect(calls[1]?.url).toBe("https://cp.example/rest/v1/agent_runs?status=eq.running&select=work_order_id");
    expect(runningWorkOrderIds).toEqual(["wo-1", "wo-2"]);

    expect(calls[2]?.url).toBe("https://cp.example/rest/v1/agent_runs?id=eq.run-1");
    expect(calls[2]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[2]?.init.body))).toMatchObject({ cost_usd: 0.2, tokens_input: 11 });

    expect(calls[3]?.url).toBe("https://cp.example/rest/v1/agent_runs?id=eq.run-1");
    expect(JSON.parse(String(calls[3]?.init.body))).toMatchObject({ status: "succeeded", pr_url: "pr", notes: "done", cost_usd: 0.3, tokens_output: 22 });

    expect(calls[4]?.url).toBe("https://cp.example/rest/v1/registry_app_repo?app_id=eq.app-1&select=github_install_id&limit=1");
    expect(installId).toBe("98765");

    expect(calls[5]?.url).toBe("https://cp.example/rest/v1/cc_audit_events");
    expect(JSON.parse(String(calls[5]?.init.body))).toEqual({ app_id: "app-1", actor: "runner", event_type: "agent_dispatched", detail: { work_order_id: "wo-1" } });
  });
});
