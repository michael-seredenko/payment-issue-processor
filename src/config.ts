/**
 * Single source of configuration. Loads .env once (Node >= 20.12; no-op without
 * a file) so the rest of the codebase reads settings from here rather than
 * touching process.env directly.
 */
try {
  process.loadEnvFile?.();
} catch {
  // no .env file — rely on the real environment (e.g. exported vars in CI)
}

const port = Number(process.env.PORT ?? 3000);

export const config = {
  port,
  /** Base URL the submit script posts to; defaults to the local server. */
  apiBaseUrl: process.env.API_URL ?? `http://localhost:${port}`,
  /** SQLite file the service and the demo share. */
  dbPath: process.env.DB_PATH ?? "issues.db",
  /**
   * Model for the decision agent. Sonnet is the right tier — policy-application
   * over a small doc, backstopped by the deterministic confidence guards — so
   * the model choice trades cost vs. reasoning quality, not safety. Set
   * AGENT_MODEL=claude-haiku-4-5 for the cheapest runs.
   */
  agentModel: process.env.AGENT_MODEL ?? "claude-sonnet-4-6",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
} as const;

/**
 * Throws with guidance when the agent can't run. Used by entry points that must
 * call the model (the demo); the long-running service only warns, since its API
 * works without a key.
 */
export function requireAnthropicApiKey(): void {
  if (!config.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — this runs the agent, which needs it. Add it to .env (see .env.example).",
    );
  }
}
