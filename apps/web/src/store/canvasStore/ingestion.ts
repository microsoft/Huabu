// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What a page shows for a node the server is preprocessing. The server
 * announces it (`preprocess` events on the Canvas Sync stream); the page
 * keeps it as display state only.
 */
export type NodeIngestionStatus = 'pending' | 'success' | 'error';

export type NodeIngestionInfo = {
  status: NodeIngestionStatus;
  updatedAt: number;
  error?: string;
};
