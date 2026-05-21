import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CP_URL = Deno.env.get("SUPABASE_URL")!;
const CP_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TRIGGER_TOKEN = Deno.env.get("AGGREGATOR_TOKEN") ?? "";

const cpHeaders = {
  apikey: CP_KEY,
  Authorization: `Bearer ${CP_KEY}`,
  "Content-Type": "application/json",
};

type ArtifactKind =
  | "doc"
  | "migration"
  | "edge_function"
  | "spec"
  | "report"
  | "web_source"
  | "script"
  | "agent_output"
  | "pull_request";

type IndexItem = {
  path: string;
  title: string;
  kind: ArtifactKind;
  byte_size?: number | null;
  content_sha?: string | null;
  summary?: string | null;
};

const ALLOWED_KINDS = new Set<ArtifactKind>([
  "doc",
  "migration",
  "edge_function",
  "spec",
  "report",
  "web_source",
  "script",
  "agent_output",
  "pull_request",
]);

async function cpGet(path: string): Promise<unknown[]> {
  const r = await fetch(`${CP_URL}/rest/v1/${path}`, { headers: cpHeaders });
  if (!r.ok) throw new Error(`control-plane GET ${path} -> ${r.status} ${await r.text()}`);
  return asArray(await r.json());
}

async function cpInsert(table: string, row: unknown): Promise<void> {
  const r = await fetch(`${CP_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...cpHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(JSON.stringify({ status: r.status, detail }));
  }
}

async function cpPatch(path: string, row: unknown): Promise<void> {
  const r = await fetch(`${CP_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...cpHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`control-plane PATCH ${path} -> ${r.status} ${await r.text()}`);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isUniqueViolationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  try {
    const parsed = JSON.parse(error.message) as { status?: number; detail?: string };
    return parsed.status === 409 && parsed.detail.includes('"code":"23505"');
  } catch {
    return false;
  }
}

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validateItem(raw: unknown): IndexItem {
  if (!raw || typeof raw !== "object") throw new Error("item must be an object");
  const r = raw as Record<string, unknown>;
  const path = typeof r.path === "string" ? r.path.trim() : "";
  const title = typeof r.title === "string" ? r.title.trim() : "";
  const kind = typeof r.kind === "string" ? r.kind : "";

  if (!path) throw new Error("path is required");
  if (!title) throw new Error("title is required");
  if (!ALLOWED_KINDS.has(kind as ArtifactKind)) throw new Error(`invalid kind '${kind}'`);

  const byteSize = r.byte_size == null ? null : Number(r.byte_size);
  if (byteSize != null && (!Number.isFinite(byteSize) || byteSize < 0)) {
    throw new Error("byte_size must be a non-negative number");
  }

  return {
    path,
    title,
    kind: kind as ArtifactKind,
    byte_size: byteSize,
    content_sha: typeof r.content_sha === "string" ? r.content_sha : null,
    summary: typeof r.summary === "string" ? r.summary : null,
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return bad("POST only", 405);

  const presented = req.headers.get("x-aggregator-token") ?? "";
  if (!TRIGGER_TOKEN || presented !== TRIGGER_TOKEN) return bad("unauthorized", 401);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return bad("invalid JSON body");
  }

  const scannedAt = typeof payload.scanned_at === "string" ? payload.scanned_at : new Date().toISOString();
  const producedBy = typeof payload.produced_by === "string" && payload.produced_by.trim()
    ? payload.produced_by.trim()
    : "cc-index-artifacts";
  const prune = payload.prune === true;

  if (!Array.isArray(payload.items)) return bad("items must be an array");

  const nowIso = new Date().toISOString();
  const errors: Array<{ path: string | null; error: string }> = [];
  const scanPaths = new Set<string>();

  let inserted = 0;
  let updated = 0;
  let failed = 0;
  let pruned = 0;

  for (const raw of payload.items) {
    let itemPath: string | null = null;
    try {
      const item = validateItem(raw);
      itemPath = item.path;
      scanPaths.add(item.path);

      // Prefer active row when duplicate historical rows exist for the same path.
      // nullsfirst ensures deleted_at=null (active) wins over soft-deleted rows.
      const existing = await cpGet(
        `cc_artifacts?select=id&source=eq.repo_scan&path=eq.${encodeURIComponent(item.path)}&order=deleted_at.asc.nullsfirst&limit=1`,
      );

      const existingFirst = existing[0];
      const existingId = isRecord(existingFirst) ? asString(existingFirst.id) : null;
      if (existingId) {
        await cpPatch(`cc_artifacts?id=eq.${existingId}`, {
          title: item.title,
          kind: item.kind,
          byte_size: item.byte_size,
          content_sha: item.content_sha,
          summary: item.summary,
          produced_by: producedBy,
          last_indexed_at: nowIso,
          deleted_at: null,
        });
        updated += 1;
      } else {
        try {
          await cpInsert("cc_artifacts", {
            app_id: null,
            kind: item.kind,
            title: item.title,
            path: item.path,
            url: null,
            source: "repo_scan",
            summary: item.summary,
            byte_size: item.byte_size,
            produced_by: producedBy,
            content_sha: item.content_sha,
            discovered_at: nowIso,
            last_indexed_at: nowIso,
          });
          inserted += 1;
        } catch (insertError) {
          if (!isUniqueViolationError(insertError)) throw insertError;
          const concurrent = await cpGet(
            `cc_artifacts?select=id&source=eq.repo_scan&path=eq.${encodeURIComponent(item.path)}&order=deleted_at.asc.nullsfirst&limit=1`,
          );
          const concurrentFirst = concurrent[0];
          const concurrentId = isRecord(concurrentFirst) ? asString(concurrentFirst.id) : null;
          if (!concurrentId) throw insertError;
          await cpPatch(`cc_artifacts?id=eq.${concurrentId}`, {
            title: item.title,
            kind: item.kind,
            byte_size: item.byte_size,
            content_sha: item.content_sha,
            summary: item.summary,
            produced_by: producedBy,
            last_indexed_at: nowIso,
            deleted_at: null,
          });
          updated += 1;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failed += 1;
      errors.push({ path: itemPath, error: msg });
      await cpInsert("cc_audit_events", {
        actor: "cc-index-artifacts",
        event_type: "artifact_index_failed",
        detail: { path: itemPath, error: msg },
      }).catch(() => {
        // audit best-effort
      });
    }
  }

  if (prune) {
    if (failed > 0 && payload.force !== true) {
      const reason = `Refusing to prune: ${failed} item(s) failed validation. Pass force=true to override.`;
      await cpInsert("cc_audit_events", {
        actor: "cc-index-artifacts",
        event_type: "prune_refused",
        detail: { reason, failed, scan_paths_size: scanPaths.size },
      }).catch(() => {
        // audit best-effort
      });
      return bad(reason, 400);
    }
    if (scanPaths.size < 5 && payload.force !== true) {
      const reason = `Refusing to prune with ${scanPaths.size} validated paths (< 5). Pass force=true to override.`;
      await cpInsert("cc_audit_events", {
        actor: "cc-index-artifacts",
        event_type: "prune_refused",
        detail: { reason, failed, scan_paths_size: scanPaths.size },
      }).catch(() => {
        // audit best-effort
      });
      return bad(reason, 400);
    }
    if (failed > 0) {
      console.warn(
        `WARN: prune requested but ${failed} items failed validation; pruning may be unsafe`,
      );
    }
    try {
      const existingRows = await cpGet("cc_artifacts?select=id,path&source=eq.repo_scan&deleted_at=is.null");
      for (const row of existingRows) {
        if (!isRecord(row)) continue;
        const rowPath = typeof row.path === "string" ? row.path : "";
        if (!rowPath || scanPaths.has(rowPath)) continue;
        try {
          const rowId = asString(row.id);
          if (!rowId) continue;
          await cpPatch(`cc_artifacts?id=eq.${rowId}`, { deleted_at: nowIso, last_indexed_at: nowIso });
          pruned += 1;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          failed += 1;
          errors.push({ path: rowPath, error: `prune failed: ${msg}` });
          await cpInsert("cc_audit_events", {
            actor: "cc-index-artifacts",
            event_type: "artifact_index_failed",
            detail: { path: rowPath, error: `prune failed: ${msg}` },
          }).catch(() => {
            // audit best-effort
          });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failed += 1;
      errors.push({ path: null, error: `prune scan failed: ${msg}` });
    }
  }

  await cpInsert("cc_audit_events", {
    actor: "cc-index-artifacts",
    event_type: "artifacts_indexed",
    detail: {
      scanned: payload.items.length,
      inserted,
      updated,
      pruned,
      failed,
    },
  }).catch(() => {
    // audit best-effort
  });

  return new Response(
    JSON.stringify(
      {
        scanned_at: scannedAt,
        indexed: payload.items.length,
        inserted,
        updated,
        pruned,
        failed,
        errors,
      },
      null,
      2,
    ),
    { headers: { "Content-Type": "application/json" } },
  );
});
