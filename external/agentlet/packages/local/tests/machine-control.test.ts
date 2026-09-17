import { describe, expect, it, vi } from 'vitest'

import {
  MachineControlInputError,
  discoverHarnesses,
  parseDiscoverHarnessesParams,
  parseValidateNativePathParams,
  resolveExecutable,
  validateNativePath,
} from '../src/machine-control.js'

describe('machine control schemas', () => {
  it('accepts bounded discovery recipes and rejects unsafe executable forms', () => {
    expect(
      parseDiscoverHarnessesParams({
        harnesses: [
          {
            harnessId: 'copilot',
            executable: 'copilot',
            versionProbe: { args: ['--version'], timeoutMs: 500 },
          },
        ],
      }),
    ).toEqual({
      harnesses: [
        {
          harnessId: 'copilot',
          executable: 'copilot',
          versionProbe: { args: ['--version'], timeoutMs: 500 },
        },
      ],
    })
    expect(() =>
      parseDiscoverHarnessesParams({
        harnesses: [{ harnessId: 'unsafe', executable: './bin/agent' }],
      }),
    ).toThrow('must be absolute or a bare executable name')
    expect(() =>
      parseDiscoverHarnessesParams({
        harnesses: [
          { harnessId: 'duplicate', executable: 'one' },
          { harnessId: 'duplicate', executable: 'two' },
        ],
      }),
    ).toThrow('Duplicate harnessId')
  })

  it('validates bounded native path params', () => {
    expect(parseValidateNativePathParams({})).toEqual({})
    expect(parseValidateNativePathParams({ cwd: '/workspace' })).toEqual({
      cwd: '/workspace',
    })
    expect(() => parseValidateNativePathParams({ cwd: '' })).toThrow(
      'cwd must be a non-empty string',
    )
  })
})

describe('harness discovery', () => {
  it('reports installed, missing, and probe failure independently', async () => {
    const probe = vi.fn(async (path: string) => {
      if (path.endsWith('broken')) throw new Error('probe exited with code 1')
      return '1.2.3'
    })
    const result = await discoverHarnesses(
      {
        harnesses: [
          {
            harnessId: 'installed',
            executable: 'installed',
            versionProbe: { args: ['--version'] },
          },
          { harnessId: 'missing', executable: 'missing' },
          {
            harnessId: 'broken',
            executable: 'broken',
            versionProbe: { args: ['--version'] },
          },
          { harnessId: 'no-probe', executable: 'no-probe' },
        ],
      },
      {
        resolve: async (command) =>
          command === 'missing' ? undefined : `/bin/${command}`,
        probe,
      },
    )

    expect(result.harnesses).toEqual([
      {
        harnessId: 'installed',
        status: 'installed',
        executablePath: '/bin/installed',
        version: '1.2.3',
      },
      { harnessId: 'missing', status: 'missing' },
      {
        harnessId: 'broken',
        status: 'probe_failed',
        executablePath: '/bin/broken',
        error: 'probe exited with code 1',
      },
      {
        harnessId: 'no-probe',
        status: 'installed',
        executablePath: '/bin/no-probe',
      },
    ])
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('resolves PATH using target platform semantics', async () => {
    const canExecute = vi.fn(
      async (candidate: string) => candidate === 'C:\\Tools\\agent.exe',
    )
    await expect(
      resolveExecutable('agent', {
        platform: 'win32',
        pathValue: 'C:\\Other;C:\\Tools',
        canExecute,
      }),
    ).resolves.toBe('C:\\Tools\\agent.exe')
  })
})

describe('native cwd validation', () => {
  const directory = { isDirectory: () => true }

  it('reports a valid target home as the default cwd', () => {
    expect(
      validateNativePath(
        {},
        {
          platform: 'linux',
          home: () => '/home/agent',
          stat: () => directory,
        },
      ),
    ).toEqual({ cwd: '/home/agent', source: 'default' })
  })

  it('uses POSIX and Windows absolute path semantics without host assumptions', () => {
    expect(
      validateNativePath(
        { cwd: '/workspace/project' },
        {
          platform: 'linux',
          stat: () => directory,
        },
      ),
    ).toEqual({ cwd: '/workspace/project', source: 'explicit' })
    expect(
      validateNativePath(
        { cwd: 'C:\\workspace\\project' },
        {
          platform: 'win32',
          stat: () => directory,
        },
      ),
    ).toEqual({ cwd: 'C:\\workspace\\project', source: 'explicit' })
    expect(
      validateNativePath(
        { cwd: '\\\\server\\share\\project' },
        {
          platform: 'win32',
          stat: () => directory,
        },
      ),
    ).toEqual({ cwd: '\\\\server\\share\\project', source: 'explicit' })
  })

  it('rejects relative, missing, and non-directory explicit paths', () => {
    expect(() =>
      validateNativePath(
        { cwd: 'relative' },
        {
          platform: 'linux',
          stat: () => directory,
        },
      ),
    ).toThrowError(
      expect.objectContaining<Partial<MachineControlInputError>>({
        code: 'path_not_absolute',
      }),
    )
    expect(() =>
      validateNativePath(
        { cwd: '/missing' },
        {
          platform: 'linux',
          stat: () => {
            throw new Error('missing')
          },
        },
      ),
    ).toThrowError(
      expect.objectContaining<Partial<MachineControlInputError>>({
        code: 'path_not_found',
      }),
    )
    expect(() =>
      validateNativePath(
        { cwd: '/file' },
        {
          platform: 'linux',
          stat: () => ({ isDirectory: () => false }),
        },
      ),
    ).toThrowError(
      expect.objectContaining<Partial<MachineControlInputError>>({
        code: 'path_not_directory',
      }),
    )
  })

  it('fails actionably when the target home is unavailable', () => {
    expect(() =>
      validateNativePath(
        {},
        {
          platform: 'win32',
          home: () => '',
          stat: () => directory,
        },
      ),
    ).toThrowError(
      expect.objectContaining<Partial<MachineControlInputError>>({
        code: 'default_cwd_unavailable',
      }),
    )
    expect(() =>
      validateNativePath(
        {},
        {
          platform: 'linux',
          home: () => {
            throw new Error('home lookup failed')
          },
          stat: () => directory,
        },
      ),
    ).toThrowError(
      expect.objectContaining<Partial<MachineControlInputError>>({
        code: 'default_cwd_unavailable',
      }),
    )
  })
})
