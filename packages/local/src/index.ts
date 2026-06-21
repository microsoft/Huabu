#!/usr/bin/env node

import { createWriteStream } from 'node:fs'
import { parseCli } from './cli.js'
import { Agentlet } from './agentlet.js'
import { Logger } from './logger.js'

const options = parseCli(process.argv)

// Setup logger
let fileWriter: ((line: string) => void) | undefined
if (options.logFile) {
  const stream = createWriteStream(options.logFile, { flags: 'a' })
  fileWriter = (line: string) => stream.write(line + '\n')
}

const logger = new Logger(options.logLevel, fileWriter)
const agentlet = new Agentlet(options, logger)

agentlet.start().catch((err) => {
  logger.error('fatal', { message: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
