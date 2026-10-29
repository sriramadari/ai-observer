import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cacheKey } from "../src/cache";
import { sha256Hex } from "../src/sha256";

const nodeSha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("sha256Hex", () => {
  it("matches the NIST test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("matches node:crypto across block boundaries and non-ASCII input", () => {
    const inputs = ["a".repeat(55), "a".repeat(56), "a".repeat(64), "x".repeat(1000), "héllo 世界 🚀", '{"k":"v"}'];
    for (const s of inputs) expect(sha256Hex(s)).toBe(nodeSha(s));
  });

  it("keeps cache keys identical to the node:crypto implementation", () => {
    const req = { model: "gpt-4o", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 64 };
    const payload = JSON.stringify({
      provider: "openai",
      model: req.model,
      messages: req.messages,
      maxTokens: req.maxTokens,
      temperature: null,
      extra: null,
    });
    expect(cacheKey("openai", req)).toBe("ai-observer:" + nodeSha(payload));
  });
});
