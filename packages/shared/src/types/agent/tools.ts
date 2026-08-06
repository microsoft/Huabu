// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Agent Tool Types
 *
 * Generic tool-response envelope shared by every agent tool, plus the
 * concrete data shapes for individual tools (web_search, ...).
 *
 * Server implementations live in `apps/server/src/modules/agent/tools/`;
 * web consumers render these payloads in chat tool messages.
 */

// --- Generic envelope -------------------------------------------------------

export type ToolName = string;

export type ToolResponse<TTool extends ToolName, TData> =
  | {
      tool: TTool;
      status: 'success';
      data: TData;
    }
  | {
      tool: TTool;
      status: 'error';
      /**
       * A user-facing, stable error message suitable for UI display.
       * Keep it short and actionable (do not include sensitive data).
       */
      error: string;
      /**
       * Optional suggestion for how to fix the issue (e.g., missing env var).
       */
      hint?: string;
    };

// --- web_search -------------------------------------------------------------

export interface WebSearchResultItem {
  title: string;
  url: string;
  content?: string;
  /**
   * Optional reference to externally stored content when the full payload is
   * too large to embed in tool messages/checkpoints.
   */
  contentRef?: string;
  favicon?: string;
  score?: number;
}

export interface WebSearchToolData {
  query: string;
  answer?: string;
  results: WebSearchResultItem[];
}

export type WebSearchToolResponse = ToolResponse<
  'web_search',
  WebSearchToolData
>;
