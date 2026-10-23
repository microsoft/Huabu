#!/usr/bin/env node

import { createWriteStream } from 'node:fs'
import { parseCli } from './cli.js'
import { Agentlet } from './agentlet.js'
import { Logger } from './logger.js'

const { options } = parseCli(process.argv)

let fileWriter: ((line: string) => void) | undefined
if (options.logFile) {
  const stream = createWriteStream(options.logFile, { flags: 'a' })
  fileWriter = (line: string) => stream.write(line + '\n')
}

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
const logger = new Logger(options.logLevel, fileWriter, (entry) => {
  const type = entry.event === 'daemon_ready' ? 'agentlet:ready'
    : entry.event === 'reconnecting' ? 'agentlet:reconnecting'
      : entry.event === 'authentication_failed' ? 'agentlet:authorization-required'
        : entry.event === 'handshake_failed' ? 'agentlet:rejected'
          : entry.event === 'stopped' ? 'agentlet:stopped' : null
  if (type) parentPort?.postMessage({
    type,
    ...(type === 'agentlet:ready' ? { agentletId: entry.agentletId } : {}),
  })
})
const agentlet = new Agentlet(options, logger)

parentPort?.on('message', ({ data }) => {
  if (data && typeof data === 'object' && 'type' in data && data.type === 'agentlet:stop') {
    void agentlet.stop()
  } else if (data && typeof data === 'object' && 'type' in data && data.type === 'agentlet:force-stop') {
    void agentlet.forceStop()
  }
})

agentlet.start().catch((err) => {
  logger.error('fatal', { message: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
