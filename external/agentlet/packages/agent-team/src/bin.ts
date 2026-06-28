#!/usr/bin/env node
/**
 * CLI entry point for @agentlet/agent-team.
 *
 * Usage:
 *   npx @agentlet/agent-team setup ./my-agent --harness claude
 *   npx @agentlet/agent-team validate ./my-agent
 *   npx @agentlet/agent-team doctor ./my-agent
 */

import { runSetup } from './setup/run-setup.js';

void runSetup();
