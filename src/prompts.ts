import type { Message } from "./types";

export interface PromptVersion {
  version: number;
  template: string;
  /** Optional default role when used to build a message. Default: "user". */
  role?: Message["role"];
  /** Optional free-text note (changelog for this version). */
  note?: string;
}

/**
 * A tiny prompt registry with versioning and `{{variable}}` interpolation.
 * Register multiple versions of a named prompt; render the latest with
 * `render("name", vars)` or a pin with `render("name@2", vars)`.
 *
 * @example
 * ```ts
 * const prompts = createPromptManager();
 * prompts.register("summarize", { version: 1, template: "Summarize: {{text}}" });
 * prompts.register("summarize", { version: 2, template: "TL;DR of:\n{{text}}" });
 * prompts.render("summarize", { text: doc });      // latest (v2)
 * prompts.render("summarize@1", { text: doc });    // pinned to v1
 * ```
 */
export class PromptManager {
  private readonly prompts = new Map<string, Map<number, PromptVersion>>();

  /** Register (or overwrite) a version of a named prompt. */
  register(name: string, version: PromptVersion): this {
    if (name.includes("@")) {
      throw new Error(`ai-observer: prompt name "${name}" must not contain "@"`);
    }
    let versions = this.prompts.get(name);
    if (!versions) {
      versions = new Map();
      this.prompts.set(name, versions);
    }
    versions.set(version.version, version);
    return this;
  }

  /** Resolve a `name` or `name@version` ref to its {@link PromptVersion}. */
  get(ref: string): PromptVersion {
    const { name, version } = parseRef(ref);
    const versions = this.prompts.get(name);
    if (!versions || versions.size === 0) {
      throw new Error(`ai-observer: no prompt registered under "${name}"`);
    }
    if (version === undefined) {
      const latest = Math.max(...versions.keys());
      return versions.get(latest) as PromptVersion;
    }
    const found = versions.get(version);
    if (!found) {
      throw new Error(`ai-observer: prompt "${name}" has no version ${version}`);
    }
    return found;
  }

  /** The canonical `name@version` label for a ref (used in traces). */
  label(ref: string): string {
    const { name } = parseRef(ref);
    return `${name}@${this.get(ref).version}`;
  }

  /** Render a prompt ref to a string, substituting `{{var}}` placeholders. */
  render(ref: string, vars: Record<string, unknown> = {}): string {
    return interpolate(this.get(ref).template, vars);
  }

  /** Render a prompt ref directly into a {@link Message}. */
  renderMessage(ref: string, vars: Record<string, unknown> = {}): Message {
    const v = this.get(ref);
    return { role: v.role ?? "user", content: interpolate(v.template, vars) };
  }

  /** List registered version numbers for a prompt, ascending. */
  versions(name: string): number[] {
    return [...(this.prompts.get(name)?.keys() ?? [])].sort((a, b) => a - b);
  }
}

export function createPromptManager(): PromptManager {
  return new PromptManager();
}

function parseRef(ref: string): { name: string; version: number | undefined } {
  const at = ref.lastIndexOf("@");
  if (at === -1) return { name: ref, version: undefined };
  const name = ref.slice(0, at);
  const v = Number(ref.slice(at + 1));
  if (!Number.isInteger(v)) throw new Error(`ai-observer: invalid prompt version in "${ref}"`);
  return { name, version: v };
}

function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}
