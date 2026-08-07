export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

export interface LogEntry {
  ts: string
  level: LogLevel
  event: string
  [key: string]: unknown
}

export class Logger {
  private level: LogLevel
  private writeFile?: (line: string) => void

  constructor(level: LogLevel, writeFile?: (line: string) => void) {
    this.level = level
    this.writeFile = writeFile
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.log('debug', event, data)
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.log('info', event, data)
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.log('warn', event, data)
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.log('error', event, data)
  }

  private log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...data,
    }

    const line = JSON.stringify(entry)

    // Always write to stderr (so stdout is reserved for potential future use)
    if (level === 'error' || level === 'warn') {
      process.stderr.write(line + '\n')
    } else {
      process.stderr.write(line + '\n')
    }

    // Optionally write to log file
    this.writeFile?.(line)
  }
}
