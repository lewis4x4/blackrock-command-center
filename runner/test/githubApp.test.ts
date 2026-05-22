import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createGitHubAppJwt, GitHubApp, normalizePrivateKey } from "../src/githubApp";

function privateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return privateKey;
}

function decodeJwtPart<T>(jwt: string, index: number): T {
  const part = jwt.split(".")[index];
  if (!part) throw new Error("missing jwt part");
  const padded = part.padEnd(part.length + ((4 - (part.length % 4)) % 4), "=").replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as T;
}

describe("GitHubApp", () => {
  test("creates a GitHub App JWT with expected claims", () => {
    const pem = privateKeyPem();
    const jwt = createGitHubAppJwt("123", pem, 1_700_000_000);
    const header = decodeJwtPart<{ alg: string; typ: string }>(jwt, 0);
    const claims = decodeJwtPart<{ iss: string; iat: number; exp: number }>(jwt, 1);

    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims.iss).toBe("123");
    expect(claims.iat).toBe(1_699_999_940);
    expect(claims.exp).toBe(1_700_000_540);
    expect(jwt.split(".")).toHaveLength(3);
  });

  test("accepts base64-encoded PEM private keys", () => {
    const pem = privateKeyPem();
    const encoded = Buffer.from(pem, "utf8").toString("base64");
    expect(normalizePrivateKey(encoded)).toBe(pem.trim());
  });

  test("looks up installation id and mints a repo-scoped installation token", async () => {
    const pem = privateKeyPem();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/repos/lewis4x4/qep/installation")) {
        return new Response(JSON.stringify({ id: 444 }), { status: 200 });
      }
      if (String(url).endsWith("/app/installations/444/access_tokens")) {
        return new Response(JSON.stringify({ token: "installation-token", expires_at: "2026-05-22T12:00:00Z" }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    };

    const app = new GitHubApp("123", pem, { fetchImpl: fetchImpl as typeof fetch, apiBaseUrl: "https://api.github.test" });
    const token = await app.mintInstallationToken("lewis4x4/qep");

    expect(token).toEqual({ token: "installation-token", expiresAt: "2026-05-22T12:00:00Z", installationId: "444" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.test/repos/lewis4x4/qep/installation",
      "https://api.github.test/app/installations/444/access_tokens",
    ]);
    const auth = (calls[0]?.init.headers as Record<string, string>).Authorization;
    expect(auth).toBeDefined();
    expect(auth!.startsWith("Bearer ")).toBe(true);
    const body = JSON.parse(String(calls[1]?.init.body));
    expect(body).toEqual({
      repositories: ["qep"],
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    });
  });

  test("opens a pull request with the installation token", async () => {
    const pem = privateKeyPem();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ html_url: "https://github.com/lewis4x4/qep/pull/123" }), { status: 201 });
    };
    const app = new GitHubApp("123", pem, { fetchImpl: fetchImpl as typeof fetch, apiBaseUrl: "https://api.github.test" });

    const prUrl = await app.openPullRequest({
      targetRepo: "lewis4x4/qep",
      headBranch: "cc/work-order",
      baseBranch: "main",
      title: "Do the thing",
      body: "body",
      token: "installation-token",
    });

    expect(prUrl).toBe("https://github.com/lewis4x4/qep/pull/123");
    expect(calls[0]?.url).toBe("https://api.github.test/repos/lewis4x4/qep/pulls");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer installation-token");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ title: "Do the thing", head: "cc/work-order", base: "main" });
  });
});

// Security regression helpers live in adjacent modules but are cheap to cover here.
