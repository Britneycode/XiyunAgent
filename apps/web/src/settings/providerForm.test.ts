import { describe, expect, it } from "vitest";
import { applyPreset, emptyForm, formatModelLines, formFrom, mergeModelIds, parseKV, parseModelLines, PRESETS, toConfig } from "./providerForm.ts";

describe("Provider 表单(M2)", () => {
  it("模型行:上下文 k/m 换算、能力标签、去重、忽略未知词", () => {
    expect(parseModelLines("gpt-4o 128k vision tools\n\n  claude 1m\nx 4096 foo\ngpt-4o 8k")).toEqual([
      { id: "gpt-4o", contextLength: 128000, capabilities: ["vision", "tools"] },
      { id: "claude", contextLength: 1_000_000 },
      { id: "x", contextLength: 4096 },
    ]);
  });

  it("模型行可往返", () => {
    const models = [{ id: "a", contextLength: 200000, capabilities: ["vision"] }, { id: "b", contextLength: 4096 }, { id: "c" }];
    expect(formatModelLines(models)).toBe("a 200k vision\nb 4096\nc");
    expect(parseModelLines(formatModelLines(models))).toEqual(models);
  });

  it("键值对按第一个分隔符切分", () => {
    expect(parseKV("api-key: {apiKey}\nX-Url: http://a:1\nbad\n: v", ":")).toEqual({ "api-key": "{apiKey}", "X-Url": "http://a:1" });
    expect(parseKV("api-version=2024=10", "=")).toEqual({ "api-version": "2024=10" });
    expect(parseKV("  ", "=")).toBeUndefined();
  });

  it("合并拉取的模型:保留已有设置,只追加新的", () => {
    expect(mergeModelIds("a 8k\n", ["b", "a", "c"])).toEqual({ text: "a 8k\nb\nc", added: 2 });
    expect(mergeModelIds("", ["x"])).toEqual({ text: "x", added: 1 });
  });

  it("Azure 预设填入协议、请求头与 api-version;toConfig 组装配置", () => {
    const azure = PRESETS.find((p) => p.name === "Azure OpenAI")!;
    const f = applyPreset(emptyForm(), azure);
    expect(f.headersText).toBe("api-key: {apiKey}");
    const c = toConfig({ ...f, modelsText: "gpt4o 128k vision", draft: { ...f.draft, params: { temperature: 0.3, maxTokens: undefined } } });
    expect(c).toMatchObject({
      name: "Azure OpenAI", protocol: "openai", model: "gpt4o",
      models: [{ id: "gpt4o", contextLength: 128000, capabilities: ["vision"] }],
      headers: { "api-key": "{apiKey}" }, query: { "api-version": "2024-10-21" }, params: { temperature: 0.3 },
    });
    expect(c.id).toBeTruthy();
  });

  it("编辑已有 Provider:清空 API Key,文本框回填", () => {
    const f = formFrom({ id: "p", name: "n", baseUrl: "u", apiKey: "********", model: "m", models: [{ id: "m", contextLength: 8000 }], headers: { a: "b" } });
    expect(f.draft.apiKey).toBe("");
    expect(f.draft.protocol).toBe("openai");
    expect(f.modelsText).toBe("m 8k");
    expect(f.headersText).toBe("a: b");
    expect(toConfig(f)).not.toHaveProperty("query");
  });
});
