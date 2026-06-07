import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IEventStorage, EventEntry } from './event-store.js'

/**
 * JSONL-based event storage backend.
 *
 * One file per session: <storeDir>/<safeSessionId>.jsonl
 * Each line: {"seq":N,"ts":"...","dir":"agent"|"host","event":{...}}
 *
 * Properties:
 * - seq = line number (line 1 = seq 1)
 * - Append-only via appendFileSync (synchronous, one syscall per event)
 * - Seq counter in memory, lazily recovered from file on first access
 */
export class JsonlStorage implements IEventStorage {
  private readonly storeDir: string
  private readonly seqCounters = new Map<string, number>()

  constructor(storeDir: string) {
    this.storeDir = storeDir
    if (!existsSync(storeDir)) {
      mkdirSync(storeDir, { recursive: true })
    }
  }

  insertEvent(sessionId: string, ts: string, dir: string, event: string): number {
    const seq = this.nextSeq(sessionId)
    const line = `{"seq":${seq},"ts":"${ts}","dir":"${dir}","event":${event}}\n`
    appendFileSync(this.filePath(sessionId), line)
    return seq
  }

  getEventsSince(sessionId: string, afterSeq: number): EventEntry[] {
    const path = this.filePath(sessionId)
    if (!existsSync(path)) return []

    const content = readFileSync(path, 'utf-8')
    const lines = content.split('\n')

    // seq = line number, so skip first afterSeq lines (no JSON.parse on skipped lines)
    const results: EventEntry[] = []
    for (let i = afterSeq; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      try {
        results.push(JSON.parse(line) as EventEntry)
      } catch {
        // Skip malformed lines (e.g., partial write on crash)
      }
    }
    return results
  }

  getMaxSeq(sessionId: string): number {
    if (this.seqCounters.has(sessionId)) {
      return this.seqCounters.get(sessionId)!
    }
    return this.recoverSeq(sessionId)
  }

  close(): void {
    this.seqCounters.clear()
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private nextSeq(sessionId: string): number {
    if (!this.seqCounters.has(sessionId)) {
      this.recoverSeq(sessionId)
    }
    const seq = (this.seqCounters.get(sessionId) ?? 0) + 1
    this.seqCounters.set(sessionId, seq)
    return seq
  }

  /** Recover seq counter from last line of JSONL file. */
  private recoverSeq(sessionId: string): number {
    const path = this.filePath(sessionId)
    if (!existsSync(path)) {
      this.seqCounters.set(sessionId, 0)
      return 0
    }

    const content = readFileSync(path, 'utf-8').trimEnd()
    if (!content) {
      this.seqCounters.set(sessionId, 0)
      return 0
    }

    // Extract seq from last non-empty line without full JSON parse
    const lastNewline = content.lastIndexOf('\n')
    const lastLine = lastNewline >= 0 ? content.substring(lastNewline + 1) : content

    let seq = 0
    try {
      const commaIdx = lastLine.indexOf(',')
      if (commaIdx > 7) {
        // Parse seq from '{"seq":N,...'
        seq = parseInt(lastLine.substring(7, commaIdx), 10)
        if (isNaN(seq)) seq = 0
      }
    } catch {
      // Malformed last line — fall back to line count
      seq = content.split('\n').filter(l => l.trim()).length
    }

    this.seqCounters.set(sessionId, seq)
    return seq
  }

  private filePath(sessionId: string): string {
    return join(this.storeDir, `${safeFilename(sessionId)}.jsonl`)
  }
}

/**
 * Sanitize sessionId for use as a filename.
 * Replace anything that's not alphanumeric, dash, underscore, or dot.
 */
function safeFilename(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_')
  // Prevent empty or dot-only filenames
  if (!safe || safe === '.' || safe === '..') return '_' + safe
  return safe
}
