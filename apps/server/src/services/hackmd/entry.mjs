// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const NOTE_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export async function noteRequest({
  config,
  operation,
  noteId,
  content,
  visibility,
}) {
  if (!['read', 'create', 'update'].includes(operation)) {
    throw new Error('Use read, create, or update');
  }
  if (
    operation === 'create' ? noteId !== undefined : !NOTE_ID.test(noteId ?? '')
  ) {
    throw new Error(
      'Provide a HackMD note ID for read/update, not a URL; omit it for create',
    );
  }
  if (
    operation === 'read' ? content !== undefined : typeof content !== 'string'
  ) {
    throw new Error('Provide Markdown content for create/update only');
  }
  if (
    visibility !== undefined &&
    (operation === 'read' || !['private', 'public'].includes(visibility))
  ) {
    throw new Error(
      'Visibility must be private or public, for create/update only',
    );
  }
  if (typeof config.apiKey !== 'string' || !config.apiKey.trim()) {
    throw new Error('HackMD API token is missing');
  }
  const permissions =
    operation === 'create' || visibility !== undefined
      ? {
          readPermission: visibility === 'public' ? 'guest' : 'owner',
          writePermission: 'owner',
        }
      : {};
  const response = await fetch(
    `https://api.hackmd.io/v1/notes${noteId ? `/${encodeURIComponent(noteId)}` : ''}`,
    {
      method: { read: 'GET', create: 'POST', update: 'PATCH' }[operation],
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      ...(operation === 'read'
        ? {}
        : {
            body: JSON.stringify({
              content,
              ...permissions,
              ...(operation === 'create'
                ? { commentPermission: 'disabled' }
                : {}),
            }),
          }),
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    },
  );
  const expectedStatus = { read: 200, create: 201, update: 202 }[operation];
  if (response.status !== expectedStatus) {
    throw new Error(
      `HackMD ${operation} returned ${response.status}; inspect the remote note before retrying any write`,
    );
  }
  if (operation === 'update') {
    return {
      id: noteId,
      url: `https://hackmd.io/${noteId}`,
      status: 'accepted',
    };
  }
  let note;
  try {
    note = await response.json();
  } catch {
    throw new Error(
      'HackMD returned invalid JSON; inspect remote state before retrying a write',
    );
  }
  if (
    !note ||
    typeof note.id !== 'string' ||
    !NOTE_ID.test(note.id) ||
    typeof note.content !== 'string'
  ) {
    throw new Error(
      'HackMD returned an invalid note; inspect remote state before retrying a write',
    );
  }
  if (
    operation === 'create' &&
    (note.readPermission !== permissions.readPermission ||
      note.writePermission !== permissions.writePermission)
  ) {
    throw new Error(
      `Created HackMD note ${note.id} has unexpected permissions; inspect it before further writes`,
    );
  }
  return {
    id: note.id,
    url: `https://hackmd.io/${note.id}`,
    content: note.content,
    readPermission: note.readPermission,
    writePermission: note.writePermission,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      'note-id': { type: 'string' },
      file: { type: 'string' },
      visibility: { type: 'string' },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(`HackMD

Usage:
  node entry.mjs read --note-id ID
  node entry.mjs create --file document.md [--visibility private|public]
  node entry.mjs update --note-id ID --file document.md [--visibility private|public]

New notes are private with comments disabled. Updates preserve permissions unless explicitly changed.
Writes require user authorization. Update returns provider acceptance, not read-back verification.
No automatic retries, publication, deletion, or synchronization.
`);
    return;
  }
  if (positionals.length !== 1)
    throw new Error('Provide exactly one operation');
  const sdkUrl = process.env.HUABU_SERVICE_SDK_URL;
  if (!sdkUrl) throw new Error('HUABU_SERVICE_SDK_URL is unavailable');
  const content =
    values.file === undefined ? undefined : await readFile(values.file, 'utf8');
  const { withServiceContext } = await import(sdkUrl);
  await withServiceContext('hackmd', async ({ config }) => {
    const result = await noteRequest({
      config,
      operation: positionals[0],
      noteId: values['note-id'],
      content,
      visibility: values.visibility,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
