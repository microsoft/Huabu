/**
 * Tiny re-export so `cli.ts` can import the env loader as a static
 * side-effect (`import './load-env-bootstrap.js'`) without pulling in
 * any Server-side modules first. `src/load-env.ts` already implements
 * the multi-tier dotenv resolution; we just want it to run before any
 * code that touches `process.env.AZURE_OPENAI_API_KEY` etc.
 */

import '../src/load-env.js';
