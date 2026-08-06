// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Prompt module barrel.
 *
 * Single import surface for everything under `src/prompt/`. Callers
 * outside the module should import from here rather than reaching
 * into `agents/loader.ts` / `skills/loader.ts` / `skills/catalogue.ts`
 * directly — that decouples the public API from any future internal
 * reorganisation.
 *
 * Note: `enrich.ts` and `resolve-label.ts` remain stand-alone and are
 * imported directly by their (only) consumer; they are kept out of
 * this barrel to keep its surface focussed on agent / skill loading.
 */

export * from './agents/loader.js';
export * from './skills/loader.js';
export * from './skills/catalogue.js';
