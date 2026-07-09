/**
 * Integrations (third-party API keys) Configuration Types
 *
 * Shared types & schemas for optional third-party integrations that the
 * server calls on the user's behalf — Tavily (web search) and RapidAPI
 * (YouTube transcripts). Per docs/architecture/api-design.md the zod
 * schema is the single source of truth; types are derived via `z.infer`.
 *
 * **Secrets never leave the server.** The read model
 * ({@link IntegrationsConfig}) only exposes booleans indicating whether a
 * key is stored — the plaintext key is never returned to the client, the
 * same masking contract used by the LLM provider config.
 */

import { z } from 'zod';

// ==================== Read model (masked) ====================

/**
 * Read-only status of stored integration credentials, returned by
 * `GET /api/integrations/config`. Contains no plaintext secrets — only
 * a boolean per integration indicating whether a key has been saved to
 * the server's `data/integrations.json`.
 */
export interface IntegrationsConfig {
  /** Whether a Tavily (web search) API key has been saved. */
  hasTavilyKey: boolean;
  /** Whether a RapidAPI (YouTube transcripts) key has been saved. */
  hasRapidApiKey: boolean;
}

// ==================== Update model ====================

/**
 * Body for `PUT /api/integrations/config`.
 *
 * Every field is optional and only applied when a non-empty string is
 * provided — mirroring the LLM config's "leave empty to keep the saved
 * key" behaviour, so the client never has to echo back an existing
 * secret it can't read.
 */
export const integrationsConfigUpdateSchema = z.object({
  /** Tavily API key. Omit or leave empty to keep the current value. */
  tavilyApiKey: z.string().optional(),
  /** RapidAPI key. Omit or leave empty to keep the current value. */
  rapidApiKey: z.string().optional(),
});

export type IntegrationsConfigUpdate = z.infer<
  typeof integrationsConfigUpdateSchema
>;
