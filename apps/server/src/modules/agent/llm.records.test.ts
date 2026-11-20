// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Model settings over server records whose reads are asynchronous: a failed
 * read and a read overtaken by a save must neither lose nor undo a save.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', async () => {
  const { default: pino } = await import('pino');
  const logger = pino({ enabled: false });
  return { logger, getLogger: () => logger };
});

let tmp: string;
const saved = {
  dataDir: process.env.HUABU_DATA_DIR,
  key: process.env.HUABU_SECRET_KEY,
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-llm-records-'));
  process.env.HUABU_DATA_DIR = tmp;
  delete process.env.HUABU_SECRET_KEY;
  vi.restoreAllMocks();
  vi.resetModules();
});
afterEach(() => {
  if (saved.dataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = saved.dataDir;
  if (saved.key === undefined) delete process.env.HUABU_SECRET_KEY;
  else process.env.HUABU_SECRET_KEY = saved.key;
  rmSync(tmp, { recursive: true, force: true });
});

/** A fresh process over the same data directory. */
async function start() {
  vi.resetModules();
  await (
    await import('../../security/secret-store.js')
  ).initializeSecretStore();
  return {
    llm: await import('./llm.js'),
    records: (await import('../storage/index.js')).getServerRecords(),
  };
}

it('refuses a save when the settings cannot be read, keeping every other setting', async () => {
  const { llm, records } = await start();
  await llm.setLLMConfig({
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: 'chat-key',
  });
  await llm.setUtilityConfig({ provider: 'openai', model: 'gpt-4o' });

  vi.spyOn(records, 'get').mockRejectedValueOnce(new Error('connection lost'));
  await expect(
    llm.setImageConfig({ provider: 'openai', model: 'gpt-image-1' }),
  ).rejects.toThrow('connection lost');

  const restarted = await start();
  expect(await restarted.llm.getLLMConfig()).toMatchObject({
    provider: 'openai',
    model: 'gpt-4o-mini',
  });
  expect(await restarted.llm.getUtilityConfig()).toMatchObject({
    provider: 'openai',
    model: 'gpt-4o',
  });
});

it('keeps a model switch saved while a cold read of the old model was pending', async () => {
  await (
    await start()
  ).llm.setLLMConfig({
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: 'chat-key',
  });
  const { llm, records } = await start();
  const read = records.get.bind(records);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(records, 'get').mockImplementationOnce(async (key) => {
    const value = await read(key);
    await gate;
    return value;
  });

  const cold = llm.getLLMConfig();
  await llm.setLLMConfig({ provider: 'openai', model: 'gpt-4o' });
  release();
  await cold;

  expect((await llm.getLLMConfig()).model).toBe('gpt-4o');
  expect((await llm.getLLMModel()).id).toBe('gpt-4o');
});
