import { ConfigKitError } from "../errors.js";
import type {
  DiscoveryEndpoint,
  DiscoveryResponseFormat,
  NormalizedModelEntry,
  NetworkPolicy,
  Protocol,
  DiscoveryCredential,
} from "../types.js";

export interface DiscoverModelsOptions {
  baseUrl: string;
  protocol: Protocol;
  apiKey?: string;
  endpoint?: DiscoveryEndpoint;
  responseFormat?: DiscoveryResponseFormat;
  credential?: DiscoveryCredential;
  network?: NetworkPolicy;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface DiscoveredModels {
  entries: NormalizedModelEntry[];
  endpoint: string;
  completeness: "complete" | "partial" | "unknown";
  asOf: string;
}

interface PageResult {
  entries: NormalizedModelEntry[];
  next: string | null;
  complete: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_MAX_PAGES = 50;
const USER_AGENT = "coding-agent-config-kit/0.1.0";

export async function discoverModels(
  options: DiscoverModelsOptions,
): Promise<DiscoveredModels> {
  const network = options.network ?? {};
  const endpoint = buildEndpointUrl(
    options.baseUrl,
    options.protocol,
    options.endpoint ?? { kind: "protocol-default" },
  );
  assertNetworkAllowed(endpoint, network);

  const format = options.responseFormat ?? defaultFormat(options.protocol);
  const headers = authHeaders(options.protocol, options.apiKey, options.credential ?? { kind: "use-provider" });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxPages = network.maxPages ?? DEFAULT_MAX_PAGES;
  const maxBytes = network.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = network.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const entries: NormalizedModelEntry[] = [];
  let next: string | null = null;
  let pages = 0;
  let complete = false;

  for (;;) {
    if (pages >= maxPages) break;
    pages += 1;
    const pageUrl = next === null ? endpoint : appendQuery(endpoint, next);
    const page = await fetchPage(pageUrl, {
      fetchImpl,
      headers,
      timeoutMs,
      maxBytes,
    });

    if (isCustomFormat(format)) {
      const parsed = parseCustom(format, page);
      return {
        entries: parsed,
        endpoint,
        completeness: format.completeness ?? "unknown",
        asOf: new Date(options.now?.() ?? Date.now()).toISOString(),
      };
    }

    const parsed = parsePage(format as Exclude<DiscoveryResponseFormat, { kind: "custom" }>, page);
    entries.push(...parsed.entries);
    complete = parsed.complete;
    next = parsed.next;
    if (next === null) break;
  }

  const completeness = completenessFromPages(
    format as Exclude<DiscoveryResponseFormat, { kind: "custom" }>,
    complete,
    next !== null,
  );
  return {
    entries: dedupe(entries),
    endpoint,
    completeness,
    asOf: new Date(options.now?.() ?? Date.now()).toISOString(),
  };
}

function defaultFormat(
  protocol: Protocol,
): Exclude<DiscoveryResponseFormat, { kind: "custom" }> {
  switch (protocol) {
    case "anthropic-messages":
      return "anthropic-model-list";
    case "google-generative-ai":
      return "google-model-list";
    case "openai-completions":
    case "openai-responses":
      return "openai-model-list";
  }
}

export function buildEndpointUrl(
  baseUrl: string,
  protocol: Protocol,
  endpoint: DiscoveryEndpoint,
): string {
  if (endpoint.kind === "absolute-url") {
    return assertHttpUrl(endpoint.url);
  }
  const base = assertHttpUrl(baseUrl);
  const basePath = new URL(base).pathname;
  if (endpoint.kind === "relative-path") {
    return appendPath(base, endpoint.path.startsWith("/") ? endpoint.path : `/${endpoint.path}`);
  }

  switch (protocol) {
    case "openai-completions":
    case "openai-responses":
      return appendPath(base, "/models");
    case "anthropic-messages":
      return appendPath(base, basePath.endsWith("/v1") ? "/models" : "/v1/models");
    case "google-generative-ai":
      return appendPath(
        base,
        basePath.includes("/v1beta") ? "/models" : "/v1beta/models",
      );
  }
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 === null) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function assertNetworkAllowed(endpoint: string, network: NetworkPolicy): void {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigKitError({
      code: "NETWORK_POLICY_DENIED",
      message: `Unsupported endpoint protocol: ${url.protocol}`,
      phase: "network",
    });
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigKitError({
      code: "NETWORK_POLICY_DENIED",
      message: "Credentials in discovery URLs are not allowed",
      phase: "network",
    });
  }

  const allowed = network.allowedHosts ?? [];
  const explicitlyAllowed =
    allowed.includes(url.hostname) || allowed.includes(url.host);
  if (
    isPrivateHostname(url.hostname) &&
    network.allowPrivateNetwork !== true &&
    !explicitlyAllowed
  ) {
    throw new ConfigKitError({
      code: "NETWORK_POLICY_DENIED",
      message: `Private discovery endpoint requires explicit permission: ${url.host}`,
      phase: "network",
    });
  }
}

function authHeaders(
  protocol: Protocol,
  apiKey: string | undefined,
  credential: DiscoveryCredential,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
  };
  if (credential.kind === "none" || apiKey === undefined || apiKey === "") return headers;

  switch (protocol) {
    case "openai-completions":
    case "openai-responses":
      headers.authorization = `Bearer ${apiKey}`;
      break;
    case "anthropic-messages":
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      break;
    case "google-generative-ai":
      headers["x-goog-api-key"] = apiKey;
      break;
  }
  return headers;
}

async function fetchPage(
  url: string,
  options: {
    fetchImpl: typeof fetch;
    headers: Record<string, string>;
    timeoutMs: number;
    maxBytes: number;
  },
): Promise<unknown> {
  let response: Response;
  try {
    response = await options.fetchImpl(url, {
      method: "GET",
      headers: options.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new ConfigKitError({
      code: "MODEL_DISCOVERY_FAILED",
      message: `Model discovery request failed for ${url}`,
      phase: "network",
      cause: error,
      details: { endpoint: url },
    });
  }

  if (response.status >= 300 && response.status < 400) {
    throw new ConfigKitError({
      code: "MODEL_DISCOVERY_FAILED",
      message: "Discovery redirects are not followed",
      phase: "network",
      details: { endpoint: url, status: response.status },
    });
  }
  if (!response.ok) {
    throw new ConfigKitError({
      code: "MODEL_DISCOVERY_FAILED",
      message: `Model discovery returned HTTP ${response.status}`,
      phase: "network",
      details: { endpoint: url, status: response.status },
    });
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
    throw new ConfigKitError({
      code: "MODEL_DISCOVERY_FAILED",
      message: "Model discovery response exceeds the size limit",
      phase: "network",
      details: { endpoint: url, maxResponseBytes: options.maxBytes },
    });
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > options.maxBytes) {
    throw new ConfigKitError({
      code: "MODEL_DISCOVERY_FAILED",
      message: "Model discovery response exceeds the size limit",
      phase: "network",
      details: { endpoint: url, maxResponseBytes: options.maxBytes },
    });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigKitError({
      code: "MODEL_DISCOVERY_FAILED",
      message: "Model discovery response is not valid JSON",
      phase: "parse",
      details: { endpoint: url },
      cause: error,
    });
  }
}

function parsePage(
  format: Exclude<DiscoveryResponseFormat, { kind: "custom" }>,
  body: unknown,
): PageResult {
  switch (format) {
    case "openai-model-list":
      return { entries: parseOpenAI(body), next: null, complete: false };
    case "anthropic-model-list":
      return parseAnthropic(body);
    case "google-model-list":
      return parseGoogle(body);
  }
}

function parseOpenAI(body: unknown): NormalizedModelEntry[] {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) throw invalidShape("openai-model-list");
  const entries: NormalizedModelEntry[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id === "") continue;
    entries.push({ requestId: record.id, displayName: record.id });
  }
  return entries;
}

function parseAnthropic(body: unknown): PageResult {
  const record = body as Record<string, unknown>;
  const data = record.data;
  if (!Array.isArray(data)) throw invalidShape("anthropic-model-list");
  const entries: NormalizedModelEntry[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const model = item as Record<string, unknown>;
    if (typeof model.id !== "string" || model.id === "") continue;
    entries.push({
      requestId: model.id,
      displayName:
        typeof model.display_name === "string" ? model.display_name : model.id,
    });
  }
  const hasMore = record.has_more === true;
  const lastId = typeof record.last_id === "string" ? record.last_id : null;
  return {
    entries,
    next: hasMore && lastId !== null ? `after_id=${encodeURIComponent(lastId)}&limit=1000` : null,
    complete: !hasMore,
  };
}

function parseGoogle(body: unknown): PageResult {
  const record = body as Record<string, unknown>;
  const models = record.models;
  if (!Array.isArray(models)) throw invalidShape("google-model-list");
  const entries: NormalizedModelEntry[] = [];
  for (const item of models) {
    if (typeof item !== "object" || item === null) continue;
    const model = item as Record<string, unknown>;
    if (typeof model.name !== "string" || model.name === "") continue;
    const requestId = model.name.replace(/^models\//, "");
    const capabilities: NormalizedModelEntry["capabilities"] = {};
    if (typeof model.inputTokenLimit === "number") {
      capabilities.contextWindow = model.inputTokenLimit;
    }
    if (typeof model.outputTokenLimit === "number") {
      capabilities.maxOutputTokens = model.outputTokenLimit;
    }
    entries.push({
      requestId,
      displayName:
        typeof model.displayName === "string" ? model.displayName : requestId,
      ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    });
  }
  const token = typeof record.nextPageToken === "string" ? record.nextPageToken : null;
  return {
    entries,
    next: token === null || token === "" ? null : `pageToken=${encodeURIComponent(token)}`,
    complete: token === null || token === "",
  };
}

function parseCustom(
  format: { kind: "custom"; name: string; parse: (body: unknown) => NormalizedModelEntry[] },
  body: unknown,
): NormalizedModelEntry[] {
  try {
    const entries = format.parse(body);
    if (!Array.isArray(entries)) throw new Error("parser did not return an array");
    return dedupe(
      entries.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.requestId === "string" &&
          entry.requestId !== "",
      ),
    );
  } catch (error) {
    throw new ConfigKitError({
      code: "MODEL_DISCOVERY_FAILED",
      message: `Custom discovery parser "${format.name}" failed`,
      phase: "parse",
      cause: error,
    });
  }
}

function completenessFromPages(
  format: Exclude<DiscoveryResponseFormat, { kind: "custom" }>,
  lastPageComplete: boolean,
  hasMore: boolean,
): "complete" | "partial" | "unknown" {
  if (format === "openai-model-list") return "unknown";
  if (hasMore) return "partial";
  if (lastPageComplete) return "complete";
  return "partial";
}

function isCustomFormat(
  format: DiscoveryResponseFormat,
): format is { kind: "custom"; name: string; parse: (body: unknown) => NormalizedModelEntry[]; completeness?: "complete" | "partial" | "unknown" } {
  return typeof format === "object" && format.kind === "custom";
}

function appendPath(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${suffix}`;
  return url.toString();
}

function appendQuery(baseUrl: string, query: string): string {
  const url = new URL(baseUrl);
  const params = new URLSearchParams(url.search);
  for (const [key, value] of new URLSearchParams(query)) params.set(key, value);
  url.search = params.toString();
  return url.toString();
}

function assertHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ConfigKitError({
      code: "UNSAFE_TARGET",
      message: "Invalid discovery URL",
      phase: "network",
      cause: error,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigKitError({
      code: "NETWORK_POLICY_DENIED",
      message: `Unsupported endpoint protocol: ${url.protocol}`,
      phase: "network",
    });
  }
  return url.toString();
}

function invalidShape(format: string): ConfigKitError {
  return new ConfigKitError({
    code: "MODEL_DISCOVERY_FAILED",
    message: `Discovery response does not match ${format}`,
    phase: "parse",
  });
}

function dedupe(entries: NormalizedModelEntry[]): NormalizedModelEntry[] {
  const seen = new Set<string>();
  const result: NormalizedModelEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.requestId)) continue;
    seen.add(entry.requestId);
    result.push(entry);
  }
  return result;
}