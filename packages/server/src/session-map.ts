/**
 * In-memory session map: tracks which ACP sessionId a user (token)
 * last used with a given agent. Enables transparent reconnection via
 * session/load without the UI needing to store state.
 *
 * Key format: "token:agentId" → sessionId
 */
export class SessionMap {
  private readonly map = new Map<string, string>()

  private key(token: string, agentId: string): string {
    return `${token}\0${agentId}`
  }

  /** Store a sessionId for a (token, agent) pair */
  set(token: string, agentId: string, sessionId: string): void {
    this.map.set(this.key(token, agentId), sessionId)
  }

  /** Look up the stored sessionId for a (token, agent) pair */
  get(token: string, agentId: string): string | undefined {
    return this.map.get(this.key(token, agentId))
  }

  /** Remove a stored session (e.g., on explicit close or error) */
  delete(token: string, agentId: string): void {
    this.map.delete(this.key(token, agentId))
  }

  /** Remove all sessions for a given agent (e.g., agent disconnected) */
  deleteByAgent(agentId: string): void {
    for (const [key] of this.map) {
      if (key.endsWith(`\0${agentId}`)) {
        this.map.delete(key)
      }
    }
  }

  /** Get all stored sessions (for debugging) */
  toJSON(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, val] of this.map) {
      out[key.replace('\0', ':')] = val
    }
    return out
  }
}
