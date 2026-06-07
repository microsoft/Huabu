import type { AcpMessage } from '@agentlet/protocol'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EventEntry {
  /** Per-session monotonic sequence number (= line number in JSONL backend) */
  seq: number
  /** ISO 8601 timestamp — when the server observed this event */
  ts: string
  /** Direction: 'agent' = agent→host, 'host' = host→agent */
  dir: 'agent' | 'host'
  /** Raw ACP JSON-RPC message, unmodified */
  event: AcpMessage
}

/**
 * Minimal storage interface for event persistence backends.
 *
 * Implementations: JsonlStorage, SqlJsStorage (future), BetterSqliteStorage (future)
 */
export interface IEventStorage {
  /**
   * Persist an event and return its assigned sequence number.
   * The implementation owns seq assignment (e.g., line number for JSONL, auto-increment for SQLite).
   */
  insertEvent(sessionId: string, ts: string, dir: string, event: string): number

  /** Read events with seq > afterSeq, in seq order. */
  getEventsSince(sessionId: string, afterSeq: number): EventEntry[]

  /** Get the highest seq number for a session, or 0 if none. */
  getMaxSeq(sessionId: string): number

  /** Release resources (file handles, DB connections). */
  close(): void
}

// ─── EventStore ───────────────────────────────────────────────────────────────

type EventSubscriber = (entry: EventEntry) => void

/**
 * Per-session event log with pub/sub for live streaming.
 *
 * Delegates persistence to an IEventStorage backend.
 * Manages subscribers for the session event WebSocket endpoint.
 */
export class EventStore {
  private readonly storage: IEventStorage
  private readonly subscribers = new Map<string, Set<EventSubscriber>>()

  constructor(storage: IEventStorage) {
    this.storage = storage
  }

  /**
   * Append an event to the session log.
   * Persists to storage, then notifies live subscribers.
   * Returns the assigned sequence number.
   */
  append(sessionId: string, dir: 'agent' | 'host', event: AcpMessage): number {
    const ts = new Date().toISOString()
    const eventJson = JSON.stringify(event)

    // Storage assigns and returns seq
    const seq = this.storage.insertEvent(sessionId, ts, dir, eventJson)

    // Notify live subscribers
    const entry: EventEntry = { seq, ts, dir, event }
    const subs = this.subscribers.get(sessionId)
    if (subs) {
      for (const cb of subs) {
        cb(entry)
      }
    }

    return seq
  }

  /** Read events with seq > afterSeq, in seq order. */
  getEventsSince(sessionId: string, afterSeq: number = 0): EventEntry[] {
    return this.storage.getEventsSince(sessionId, afterSeq)
  }

  /** Get the highest seq number for a session, or 0 if none. */
  getMaxSeq(sessionId: string): number {
    return this.storage.getMaxSeq(sessionId)
  }

  /**
   * Subscribe to live events for a session.
   * Returns an unsubscribe function.
   */
  subscribe(sessionId: string, callback: EventSubscriber): () => void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set())
    }
    this.subscribers.get(sessionId)!.add(callback)

    return () => {
      const subs = this.subscribers.get(sessionId)
      if (subs) {
        subs.delete(callback)
        if (subs.size === 0) {
          this.subscribers.delete(sessionId)
        }
      }
    }
  }

  /** Release all resources. */
  close(): void {
    this.subscribers.clear()
    this.storage.close()
  }
}
