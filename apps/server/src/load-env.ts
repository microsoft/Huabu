import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

// Load env files in priority order. dotenv does NOT override existing
// process.env values, so the first call wins per key:
//   1. Shell / platform env vars (highest)
//   2. apps/server/.env       — server-private secrets (LLM keys, etc.)
//   3. <repo-root>/.env       — shared dev parameters (ports, host)
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../.env') });
dotenv.config({ path: path.resolve(here, '../../../.env') });
