#!/usr/bin/env node

import { createWriteStream } from 'node:fs'
import { parseCli } from './cli.js'
import { Bridge } from './bridge.js'
import { Daemon } from './daemon.js'
import { Logger } from './logger.js'

const result = parseCli(process.argv)

// Setup logger
let fileWriter: ((line: string) => void) | undefined
const logFile = result.options.logFile
if (logFile) {
  const stream = createWriteStream(logFile, { flags: 'a' })
  fileWriter = (line: string) => stream.write(line + '\n')
}

const logger = new Logger(result.options.logLevel, fileWriter)

if (result.mode === 'daemon') {
  const daemon = new Daemon(result.options, logger)
  daemon.start().catch((err) => {
    logger.error('fatal', { message: err instanceof Error ? err.message : String(err) })
    process.exit(1)
  })
} else {
  const bridge = new Bridge(result.options, logger)
  bridge.start().catch((err) => {
    logger.error('fatal', { message: err instanceof Error ? err.message : String(err) })
    process.exit(1)
  })
}
