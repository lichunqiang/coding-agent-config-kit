import { describe, expect, it } from "vitest";

import {
  buildEndpointUrl,
  discoverModels,
  isPrivateHostname,
} from "../../src/models/discovery.js";

interface FakeCall {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(responses: Array<() => Response>): {
  calls: FakeCall[];
  fetchImpl: typeof fetch;
} {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected extra fetch");
    return next();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("buildEndpointUrl", () => {
  it("uses protocol defaults without duplicating /v1", () => {
    expect(
      buildEndpointUrl("https://api.example.com/v1", "openai-completions", {
        kind: "protocol-default",
      }),
    ).toBe("https://api.example.com/v1/models");
    expect(
      buildEndpointUrl("https://api.anthropic.com", "anthropic-messages", {
        kind: "protocol-default",
      }),
    ).toBe("https://api.anthropic.com/v1/models");
    expect(
      buildEndpointUrl("https://api.anthropic.com/v1", "anthropic-messages", {
        kind: "protocol-default",
      }),
    ).toBe("https://api.anthropic.com/v1/models");
    expect(
      buildEndpointUrl("https://generativelanguage.googleapis.com", "google-generative-ai", {
        kind: "protocol-default",
      }),
    ).toBe("https://generativelanguage.googleapis.com/v1beta/models");
  });

  it("supports absolute and relative endpoints", () => {
    expect(
      buildEndpointUrl("https://api.example.com/v1", "openai-completions", {
        kind: "absolute-url",
        url: "https://catalog.example.com/models",
      }),
    ).toBe("https://catalog.example.com/models");
    expect(
      buildEndpointUrl("https://api.example.com/v1", "openai-completions", {
        kind: "relative-path",
        path: "catalog",
      }),
    ).toBe("https://api.example.com/v1/catalog");
  });
});

describe("network policy", () => {
  it("classifies private hosts", () => {
    expect(isPrivateHostname("localhost")).toBe(true);
    expect(isPrivateHostname("127.0.0.1")).toBe(true);
    expect(isPrivateHostname("10.1.2.3")).toBe(true);
    expect(isPrivateHostname("172.16.0.1")).toBe(true);
    expect(isPrivateHostname("192.168.1.1")).toBe(true);
    expect(isPrivateHostname("169.254.169.254")).toBe(true);
    expect(isPrivateHostname("::1")).toBe(true);
    expect(isPrivateHostname("api.example.com")).toBe(false);
  });

  it("blocks private endpoints unless allowed", async () => {
    const { fetchImpl } = fakeFetch([() => json({ data: [] })]);
    await expect(
      discoverModels({
        baseUrl: "http://127.0.0.1:8080/v1",
        protocol: "openai-completions",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "NETWORK_POLICY_DENIED" });
  });

  it("allows explicitly configured private endpoints", async () => {
    const { fetchImpl, calls } = fakeFetch([() => json({ data: [{ id: "m" }] })]);
    const result = await discoverModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      protocol: "openai-completions",
      network: { allowPrivateNetwork: true },
      fetchImpl,
    });
    expect(result.entries.map((entry) => entry.requestId)).toEqual(["m"]);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8080/v1/models");
  });
});

describe("discoverModels", () => {
  it("parses an OpenAI model list and sends bearer auth", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => json({ data: [{ id: "a" }, { id: "b", name: "ignored" }] }),
    ]);
    const result = await discoverModels({
      baseUrl: "https://api.example.com/v1",
      protocol: "openai-completions",
      apiKey: "secret",
      fetchImpl,
    });
    expect(result.entries).toEqual([
      { requestId: "a", displayName: "a" },
      { requestId: "b", displayName: "b" },
    ]);
    expect(result.completeness).toBe("unknown");
    expect(calls[0]?.headers.authorization).toBe("Bearer secret");
  });

  it("follows Anthropic pagination", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => json({ data: [{ id: "a", display_name: "A" }], has_more: true, last_id: "a" }),
      () => json({ data: [{ id: "b" }], has_more: false }),
    ]);
    const result = await discoverModels({
      baseUrl: "https://api.anthropic.com",
      protocol: "anthropic-messages",
      apiKey: "secret",
      fetchImpl,
    });
    expect(result.entries.map((entry) => entry.requestId)).toEqual(["a", "b"]);
    expect(result.completeness).toBe("complete");
    expect(calls[0]?.headers["x-api-key"]).toBe("secret");
    expect(calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[1]?.url).toContain("after_id=a");
  });

  it("follows Google pagination and reads limits", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () =>
        json({
          models: [
            {
              name: "models/gemini-x",
              displayName: "Gemini X",
              inputTokenLimit: 1000,
              outputTokenLimit: 100,
            },
          ],
          nextPageToken: "t1",
        }),
      () => json({ models: [{ name: "models/gemini-y" }] }),
    ]);
    const result = await discoverModels({
      baseUrl: "https://generativelanguage.googleapis.com",
      protocol: "google-generative-ai",
      apiKey: "secret",
      fetchImpl,
    });
    expect(result.entries).toEqual([
      {
        requestId: "gemini-x",
        displayName: "Gemini X",
        capabilities: { contextWindow: 1000, maxOutputTokens: 100 },
      },
      { requestId: "gemini-y", displayName: "gemini-y" },
    ]);
    expect(result.completeness).toBe("complete");
    expect(calls[0]?.headers["x-goog-api-key"]).toBe("secret");
    expect(calls[1]?.url).toContain("pageToken=t1");
  });

  it("rejects redirects rather than following them", async () => {
    const { fetchImpl } = fakeFetch([
      () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
    ]);
    await expect(
      discoverModels({
        baseUrl: "https://api.example.com/v1",
        protocol: "openai-completions",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "MODEL_DISCOVERY_FAILED" });
  });

  it("rejects oversized responses", async () => {
    const { fetchImpl } = fakeFetch([() => json({ data: [{ id: "x".repeat(50) }] })]);
    await expect(
      discoverModels({
        baseUrl: "https://api.example.com/v1",
        protocol: "openai-completions",
        network: { maxResponseBytes: 10 },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "MODEL_DISCOVERY_FAILED" });
  });

  it("supports a custom parser", async () => {
    const { fetchImpl } = fakeFetch([() => json({ models: ["x", "y"] })]);
    const result = await discoverModels({
      baseUrl: "https://api.example.com/v1",
      protocol: "openai-completions",
      responseFormat: {
        kind: "custom",
        name: "test",
        parse: (body) =>
          ((body as { models: string[] }).models).map((id) => ({ requestId: id })),
        completeness: "partial",
      },
      fetchImpl,
    });
    expect(result.entries.map((entry) => entry.requestId)).toEqual(["x", "y"]);
    expect(result.completeness).toBe("partial");
  });
});