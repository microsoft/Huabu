/**
 * API Configuration
 * Centralized configuration for API endpoints
 */
export const API_CONFIG = {
  /**
   * Base URL for the API server
   * Can be overridden by VITE_API_BASE environment variable
   */
  BASE_URL: import.meta.env.VITE_API_BASE || 'http://localhost:3000',

  /**
   * Full API path (includes /api prefix)
   */
  get API_URL() {
    return `${this.BASE_URL}/api`;
  },
} as const;
