import type { NormalizedRequest, ProviderResult } from "../types";
import { type AdapterOptions, type ProviderAdapter, postJson } from "./base";

/** Opus 4.8 / 4.7 reject temperature/top_p/top_k — drop sampling params for these. */
const NO_SAMPLING = new Set(["claude-opus-4-8", "claude-opus-4-7"]);

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Anthropic Messages API adapter (`POST /v1/messages`).
 * Default model: `claude-opus-4-8`. `max_tokens` is required by the API.
 * `system` messages are hoisted to the top-level `system` parameter.
 */
export const anthropicAdapter: ProviderAdapter = {
  name: "anthropic",
  defaultModel: "claude-opus-4-8",

  async chat(req: NormalizedRequest, opts: AdapterOptions): Promise<ProviderResult> {
    const base = opts.baseUrl ?? "https://api.anthropic.com";
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      messages,
      ...(system ? { system } : {}),
      ...(req.extra ?? {}),
    };
    if (req.temperature !== undefined && !NO_SAMPLING.has(req.model)) {
      body.temperature = req.temperature;
    }

    const json = (await postJson(
      `${base}/v1/messages`,
      body,
      {
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      opts,
      "anthropic",
    )) as AnthropicResponse;

    const text = (json.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");

    return {
      text,
      model: json.model ?? req.model,
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        totalTokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
      },
      finishReason: json.stop_reason,
      raw: json,
    };
  },
};
