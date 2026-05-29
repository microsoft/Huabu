import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface TokenEntry {
  user: string
  expireTime: number | null
}

export type TokenMap = Record<string, TokenEntry>

/**
 * In-memory token store with hot-reload support.
 * Token map format: { "tok_abc": { "user": "alice", "expireTime": null }, ... }
 */
export class TokenStore {
  private tokens = new Map<string, TokenEntry>()

  /** Load tokens from a CLI argument (bare token string or JSON file path) */
  loadFromArg(token: string): void {
    const fullPath = resolve(token)
    if (existsSync(fullPath)) {
      const raw = readFileSync(fullPath, 'utf-8')
      const parsed = JSON.parse(raw) as TokenMap
      this.replace(parsed)
    } else {
      // Bare token — create a single entry
      this.tokens.set(token, { user: 'default', expireTime: null })
    }
  }

  /** Atomically replace the entire token map */
  replace(map: TokenMap): void {
    this.tokens.clear()
    for (const [key, entry] of Object.entries(map)) {
      this.tokens.set(key, entry)
    }
  }

  /** Validate a token. Returns the entry if valid, null if invalid/expired. */
  validate(token: string): TokenEntry | null {
    const entry = this.tokens.get(token)
    if (!entry) return null
    if (entry.expireTime !== null && Date.now() / 1000 > entry.expireTime) {
      return null
    }
    return entry
  }

  /** Get all tokens as a plain object (for admin GET) */
  toJSON(): TokenMap {
    const result: TokenMap = {}
    for (const [key, entry] of this.tokens) {
      result[key] = entry
    }
    return result
  }

  /** Check if a token exists (regardless of expiry) */
  has(token: string): boolean {
    return this.tokens.has(token)
  }

  /** Get user name for a token */
  getUser(token: string): string | null {
    return this.tokens.get(token)?.user ?? null
  }
}
