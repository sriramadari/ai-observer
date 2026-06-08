import type { NormalizedRequest, ProviderResult } from "../types";
import { type AdapterOptions, type ProviderAdapter, postJson } from "./base";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Google Gemini adapter (`generativelanguage.googleapis.com` `:generateContent`).
 * Default model: `gemini-1.5-pro`. The API key is passed as a query parameter.
 * `system` messages map to `systemInstruction`; assistant → `model` role.
 */
export const geminiAdapter: ProviderAdapter = {
  name: "gemini",
  defaultModel: "gemini-1.5-pro",

  async chat(req: NormalizedRequest, opts: AdapterOptions): Promise<ProviderResult> {
    const base = opts.baseUrl ?? "https://generativelanguage.googleapis.com";
    const url = `${base}/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;

    const systemText = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const body: Record<string, unknown> = {
      contents,
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      },
      ...(req.extra ?? {}),
    };

    const json = (await postJson(url, body, {}, opts, "gemini")) as GeminiResponse;

    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");

    return {
      text,
      model: req.model,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
        totalTokens:
          (json.usageMetadata?.promptTokenCount ?? 0) +
          (json.usageMetadata?.candidatesTokenCount ?? 0),
      },
      finishReason: candidate?.finishReason,
      raw: json,
    };
  },
};
