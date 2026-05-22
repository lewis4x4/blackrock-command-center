import { createSign } from "node:crypto";
import type { Logger } from "./log";

export type InstallationToken = {
  token: string;
  expiresAt: string;
  installationId: string;
};

export type PullRequestInput = {
  targetRepo: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  token: string;
};

export interface GitHubTokenProvider {
  mintInstallationToken(targetRepo: string, installationId?: string | null): Promise<InstallationToken>;
}

export interface GitHubPullRequestClient {
  openPullRequest(input: PullRequestInput): Promise<string>;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function parseRepo(repo: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length > 0) throw new Error(`target_repo must be owner/name, got ${repo}`);
  return { owner, name };
}

export function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed.replace(/\\n/g, "\n");

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
    if (decoded.includes("-----BEGIN")) return decoded.replace(/\\n/g, "\n");
  } catch {
    // fall through to the original value
  }
  return trimmed.replace(/\\n/g, "\n");
}

export function createGitHubAppJwt(appId: string, privateKey: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = { alg: "RS256", typ: "JWT" };
  // Backdate slightly to avoid clock skew. GitHub App JWT max lifetime is 10 minutes.
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(normalizePrivateKey(privateKey));
  return `${signingInput}.${base64url(signature)}`;
}

export class GitHubApp implements GitHubTokenProvider, GitHubPullRequestClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly privateKey: string;

  constructor(
    private readonly appId: string,
    privateKey: string,
    options: { fetchImpl?: typeof fetch; apiBaseUrl?: string; logger?: Logger } = {},
  ) {
    this.privateKey = normalizePrivateKey(privateKey);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  }

  async mintInstallationToken(targetRepo: string, installationId?: string | null): Promise<InstallationToken> {
    const { owner, name } = parseRepo(targetRepo);
    const jwt = createGitHubAppJwt(this.appId, this.privateKey);
    const resolvedInstallationId = installationId?.trim() || await this.lookupInstallationId(owner, name, jwt);

    const response = await this.githubFetch(`/app/installations/${resolvedInstallationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repositories: [name],
        permissions: {
          contents: "write",
          pull_requests: "write",
          metadata: "read",
        },
      }),
    });

    const payload = await response.json() as { token?: string; expires_at?: string };
    if (!payload.token || !payload.expires_at) throw new Error("GitHub installation token response was missing token or expires_at");
    return { token: payload.token, expiresAt: payload.expires_at, installationId: resolvedInstallationId };
  }

  async openPullRequest(input: PullRequestInput): Promise<string> {
    const { owner, name } = parseRepo(input.targetRepo);
    const response = await this.githubFetch(`/repos/${owner}/${name}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: input.title,
        head: input.headBranch,
        base: input.baseBranch,
        body: input.body,
        maintainer_can_modify: true,
      }),
    });
    const payload = await response.json() as { html_url?: string };
    if (!payload.html_url) throw new Error("GitHub PR response was missing html_url");
    return payload.html_url;
  }

  private async lookupInstallationId(owner: string, repo: string, jwt: string): Promise<string> {
    const response = await this.githubFetch(`/repos/${owner}/${repo}/installation`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const payload = await response.json() as { id?: number | string };
    if (payload.id == null) throw new Error(`GitHub installation lookup for ${owner}/${repo} did not return id`);
    return String(payload.id);
  }

  private async githubFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "blackrock-command-center-runner",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub ${init.method ?? "GET"} ${path} -> ${response.status}: ${body}`);
    }
    return response;
  }
}

export class MockGitHubApp implements GitHubTokenProvider, GitHubPullRequestClient {
  async mintInstallationToken(targetRepo: string, installationId?: string | null): Promise<InstallationToken> {
    return {
      token: `mock-token-for-${targetRepo}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      installationId: installationId || "mock-installation",
    };
  }

  async openPullRequest(input: PullRequestInput): Promise<string> {
    const idPart = input.headBranch.split("/").pop() || "work-order";
    return `https://github.com/${input.targetRepo}/pull/mock-${idPart}`;
  }
}
