// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * API Configuration
 * Centralized configuration for API endpoints
 */
export const API_CONFIG = {
  /**
   * Base URL for the API server.
   * Defaults to '' (relative paths) so requests go to the same origin
   * as the web page. In dev, Vite proxies /api to the backend
   * (see vite.config.ts). In prod, a reverse proxy (nginx/Caddy) should
   * forward /api to the server. Override with VITE_API_BASE only when
   * the API lives on a different origin (e.g. cross-domain deployments).
   */
  BASE_URL: import.meta.env.VITE_API_BASE ?? '',

  /**
   * Full API path (includes /api prefix)
   */
  get API_URL() {
    return `${this.BASE_URL}/api`;
  },
} as const;
