import type { NormalizedRequest, ProviderResult } from "../types";
import { type AdapterOptions, type ProviderAdapter, postJson } from "./base";

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * OpenAI Chat Completions adapter (`POST /v1/chat/completions`).
 * Default model: `gpt-4o` (override per provider/request as needed).
 */
export const openaiAdapter: ProviderAdapter = {
  name: "openai",
  defaultModel: "gpt-4o",

  async chat(req: NormalizedRequest, opts: AdapterOptions): Promise<ProviderResult> {
    const base = opts.baseUrl ?? "https://api.openai.com";
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.extra ?? {}),
    };

    const json = (await postJson(
      `${base}/v1/chat/completions`,
      body,
      { authorization: `Bearer ${opts.apiKey}` },
      opts,
      "openai",
    )) as OpenAIResponse;

    const choice = json.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      model: json.model ?? req.model,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: (json.usage?.prompt_tokens ?? 0) + (json.usage?.completion_tokens ?? 0),
      },
      finishReason: choice?.finish_reason,
      raw: json,
    };
  },
};
