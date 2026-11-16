import { describe, expect, it } from "vitest";

import {
  parseTomlText,
  removeTomlTable,
  removeTomlTopLevel,
  setTomlTable,
  setTomlTopLevel,
} from "../../src/editing/toml.js";

const sample = `# Codex configuration
model = "gpt-5" # keep this comment
model_provider = "openai"

[model_providers.company]
name = "Company"
base_url = "https://old.example.com/v1" # old base
env_key = "COMPANY_KEY"
wire_api = "responses"

[model_providers.company.http_headers]
x-custom = "1"

[profiles.fast]
model = "gpt-5-mini"
`;

describe("TOML editing", () => {
  it("updates values without losing comments or unrelated tables", () => {
    let text = setTomlTopLevel(sample, "model", "gpt-6", "config.toml");
    text = setTomlTable(
      text,
      ["model_providers", "company"],
      {
        name: "Company",
        base_url: "https://api.example.com/v1",
        env_key: "NEW_KEY",
        wire_api: "responses",
      },
      "config.toml",
    );
    expect(text).toContain("model = \"gpt-6\" # keep this comment");
    expect(text).toContain("base_url = \"https://api.example.com/v1\" # old base");
    expect(text).toContain("env_key = \"NEW_KEY\"");
    expect(text).toContain("[model_providers.company.http_headers]");
    expect(text).toContain("[profiles.fast]");

    const parsed = parseTomlText(text, "config.toml");
    expect(parsed.model).toBe("gpt-6");
    expect(
      (parsed.model_providers as Record<string, Record<string, unknown>>).company?.base_url,
    ).toBe("https://api.example.com/v1");
  });

  it("adds missing keys and tables", () => {
    let text = setTomlTable(
      "model = \"gpt-5\"\n",
      ["model_providers", "newco"],
      { base_url: "https://new.example.com", wire_api: "responses" },
      "config.toml",
    );
    text = setTomlTopLevel(text, "model_provider", "newco", "config.toml");
    const parsed = parseTomlText(text, "config.toml");
    const providers = parsed.model_providers as Record<string, Record<string, unknown>>;
    expect(providers.newco?.base_url).toBe("https://new.example.com");
    expect(parsed.model_provider).toBe("newco");
  });

  it("removes a table together with its subtables", () => {
    const text = removeTomlTable(sample, ["model_providers", "company"], "config.toml");
    expect(text).not.toContain("model_providers.company");
    expect(text).not.toContain("http_headers");
    expect(text).toContain("[profiles.fast]");
    expect(parseTomlText(text, "config.toml").model).toBe("gpt-5");
  });

  it("removes a top-level key", () => {
    const text = removeTomlTopLevel(sample, "model_provider", "config.toml");
    const parsed = parseTomlText(text, "config.toml");
    expect(parsed.model_provider).toBeUndefined();
    expect(parsed.model).toBe("gpt-5");
  });

  it("refuses multiline values rather than corrupting them", () => {
    const text = `[model_providers.company]\nheaders = [\n  "a",\n  "b",\n]\n`;
    expect(() =>
      setTomlTable(text, ["model_providers", "company"], { base_url: "x" }, "config.toml"),
    ).not.toThrow();
    expect(() =>
      setTomlTable(
        text,
        ["model_providers", "company"],
        { headers: ["c"] },
        "config.toml",
      ),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_INTENT" }));
  });

  it("rejects malformed TOML", () => {
    expect(() => parseTomlText("not = [", "config.toml")).toThrowError(
      expect.objectContaining({ code: "UNPARSEABLE_CONFIG" }),
    );
  });
});