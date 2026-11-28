// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What a page shows for a node the server is preprocessing. The server
 * announces a run's start and end (`preprocess` events on the Canvas Sync
 * stream); the page keeps an entry only while the run is under way.
 */
export type NodeIngestionInfo = { status: 'pending' };
