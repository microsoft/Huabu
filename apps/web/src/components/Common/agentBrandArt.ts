// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Harness brand logos used as agent avatars.
 *
 * The artwork is not vendored: each entry imports one file from the
 * `@lobehub/icons-static-svg` dependency (MIT), and only the files listed here
 * reach the bundle. The logos are trademarks of their respective owners and are
 * shown unmodified, only to identify the third-party agent a Profile launches.
 *
 * Files are imported with `?inline` so every logo is a data URL: a CSS mask
 * image is fetched with CORS, which would fail for a separate asset file on an
 * origin that does not allow it, and an inlined logo needs no extra request.
 *
 * A `mono` logo is a single-color mark that must follow the theme, so it is
 * painted as a mask in the current foreground color. The others carry their
 * own brand colors and are painted as-is.
 *
 * To add a logo, import the upstream file here and add the brand id to the
 * shared `agentIconSchema` and `AGENT_ICON_BRANDS`.
 */

import claude from '@lobehub/icons-static-svg/icons/claude-color.svg?inline';
import codebuddy from '@lobehub/icons-static-svg/icons/codebuddy-color.svg?inline';
import codex from '@lobehub/icons-static-svg/icons/codex.svg?inline';
import cursor from '@lobehub/icons-static-svg/icons/cursor.svg?inline';
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg?inline';
import copilot from '@lobehub/icons-static-svg/icons/githubcopilot.svg?inline';
import hermes from '@lobehub/icons-static-svg/icons/hermesagent.svg?inline';
import kimi from '@lobehub/icons-static-svg/icons/kimi.svg?inline';
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg?inline';
import pi from '@lobehub/icons-static-svg/icons/pi.svg?inline';
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg?inline';

import type { AgentIconBrand } from '@huabu/shared';

export type AgentBrandArt = {
  /** Data URL of the logo file. */
  src: string;
  /** Whether the logo is a single-color mark painted in the theme foreground. */
  mono: boolean;
};

export const AGENT_BRAND_ART: Record<AgentIconBrand, AgentBrandArt> = {
  claude: { src: claude, mono: false },
  codebuddy: { src: codebuddy, mono: false },
  codex: { src: codex, mono: true },
  copilot: { src: copilot, mono: true },
  cursor: { src: cursor, mono: true },
  gemini: { src: gemini, mono: false },
  hermes: { src: hermes, mono: true },
  // The color variant mixes brand blue with `currentColor`, which a file
  // painted as an image cannot inherit, so the single-color mark is used.
  kimi: { src: kimi, mono: true },
  opencode: { src: opencode, mono: true },
  pi: { src: pi, mono: true },
  qwen: { src: qwen, mono: false },
};
