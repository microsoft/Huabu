// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Gives storage the rule its SQL backends run in the upgrade to schema
 * version 5: the order keys of Spaces stored before nodes carried them.
 *
 * Imported for its effect by every entrance that can open a database for
 * writing and so upgrade it: `storage/storage.ts`, which composes storage
 * for the Server, and the standalone `setup`, which opens the database's
 * server records without composing storage. The backends, and the dev web
 * server's read-only secret lookup, do not import it: they must not depend
 * on the canvas engine.
 */

import { stateWithOrderKeys } from './stored-node-order.js';
import {
  provideSpaceStateRewrite,
  SPACE_ORDER_KEYS_REWRITE,
} from '../storage/ports/space-state-rewrites.js';

provideSpaceStateRewrite(SPACE_ORDER_KEYS_REWRITE, stateWithOrderKeys);
