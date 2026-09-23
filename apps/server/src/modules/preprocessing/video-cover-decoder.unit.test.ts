// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { exec, now, resolveBinary } = vi.hoisted(() => ({
  exec: vi.fn(),
  now: vi.fn(() => 0),
  resolveBinary: vi.fn(async () => '/app/media/ffmpeg'),
}));

vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: exec,
  }),
}));
vi.mock('node:perf_hooks', () => ({ performance: { now } }));
vi.mock('./video-ffmpeg.js', () => ({ getVideoFfmpegPath: resolveBinary }));

import { extractLocalVideoCover } from './video-cover-decoder.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const input = '/leased/video with spaces;$(ignored).mp4';
const durationListing = (duration = '00:01:00.00') =>
  `Input #0, mov, from '${input}':\n  Duration: ${duration}, start: 0.000000, bitrate: 12 kb/s\n  Stream #0:0: Video: h264\n`;
const artwork = '  Stream #0:2: Video: mjpeg (attached pic)\n';
const result = (stdout = jpeg) => ({ stdout, stderr: Buffer.alloc(0) });
const list = (text = durationListing()) =>
  exec.mockRejectedValueOnce({ code: 1, stderr: Buffer.from(text) });
const argsAt = (index: number): string[] => exec.mock.calls[index]?.[1] ?? [];
const filterAt = (index: number) => {
  const args = argsAt(index);
  return args[args.indexOf('-vf') + 1] ?? '';
};

beforeEach(() => {
  exec.mockReset();
  now.mockReset().mockReturnValue(0);
  resolveBinary.mockClear();
});

describe('bounded FFmpeg cover subprocesses', () => {
  it('uses an input seek and time bound, scales before buffering at most 12 samples', async () => {
    list();
    exec.mockResolvedValueOnce(result());
    expect(await extractLocalVideoCover(input)).toEqual(jpeg);
    expect(exec).toHaveBeenCalledTimes(2);
    const args = argsAt(1);
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-i') + 2)).toEqual([
      '-ss',
      '1',
      '-t',
      '6',
      '-i',
      input,
    ]);
    expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2)).toEqual([
      '-map',
      '0:V:0',
    ]);
    expect(filterAt(1)).toBe(
      "trim=duration=6,fps=fps=2:round=near:eof_action=pass,scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease,format=yuv420p,trim=end_frame=12,thumbnail=n=12",
    );
    for (const [binary, callArgs, options] of exec.mock.calls) {
      expect(binary).toBe('/app/media/ffmpeg');
      expect(callArgs).toContain(input);
      expect(
        callArgs.slice(
          callArgs.indexOf('-protocol_whitelist'),
          callArgs.indexOf('-protocol_whitelist') + 2,
        ),
      ).toEqual(['-protocol_whitelist', 'file,pipe']);
      const formats = callArgs[callArgs.indexOf('-format_whitelist') + 1];
      expect(formats).toBe(
        'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,flv,mpegts,mpeg,ogg,asf',
      );
      expect(options).toMatchObject({
        shell: false,
        killSignal: 'SIGKILL',
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'buffer',
        windowsHide: true,
      });
      expect(options.env.AV_LOG_FORCE_NOCOLOR).toBe('1');
      expect(
        callArgs.slice(
          callArgs.indexOf('-threads'),
          callArgs.indexOf('-threads') + 2,
        ),
      ).toEqual(['-threads', '1']);
    }
    expect(args.slice(-2)).toEqual(['image2pipe', 'pipe:1']);
    expect(
      args.slice(args.indexOf('-frames:v'), args.indexOf('-frames:v') + 2),
    ).toEqual(['-frames:v', '1']);
    expect(
      args.slice(
        args.indexOf('-filter_threads'),
        args.indexOf('-filter_threads') + 4,
      ),
    ).toEqual(['-filter_threads', '1', '-threads', '1']);
  });

  it('adapts the skip to one tenth of a known short duration', async () => {
    list(durationListing('00:00:04.00'));
    exec.mockResolvedValueOnce(result());
    await extractLocalVideoCover(input);
    expect(argsAt(1)[argsAt(1).indexOf('-ss') + 1]).toBe('0.4');
  });

  it.each(['00:00:00.04', '00:00:00.20', '00:00:01.00'])(
    'directly decodes the first frame for duration %s',
    async (duration) => {
      list(durationListing(duration));
      exec.mockResolvedValueOnce(result());
      await extractLocalVideoCover(input);
      expect(argsAt(1)).not.toContain('-ss');
      expect(filterAt(1)).not.toMatch(/fps|thumbnail/);
    },
  );

  it.each(['N/A', '00:00:00.00'])(
    'uses a bounded default seek for unknown duration %s, then retries empty output at zero',
    async (duration) => {
      list(durationListing(duration));
      exec
        .mockResolvedValueOnce(result(Buffer.alloc(0)))
        .mockResolvedValueOnce(result());
      expect(await extractLocalVideoCover(input)).toEqual(jpeg);
      expect(argsAt(1)[argsAt(1).indexOf('-ss') + 1]).toBe('1');
      expect(argsAt(2)).not.toContain('-ss');
      expect(filterAt(2)).not.toMatch(/fps|thumbnail/);
      expect(exec).toHaveBeenCalledTimes(3);
    },
  );

  it('keeps embedded artwork first with no sampling when it succeeds', async () => {
    list(durationListing() + artwork);
    exec.mockResolvedValueOnce(result());
    await extractLocalVideoCover(input);
    expect(argsAt(1)).toContain('0:2');
    expect(argsAt(1)).not.toContain('-ss');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('shares one deadline across listing, broken artwork, sampling timeout and first-frame retry', async () => {
    let elapsed = 0;
    now.mockImplementation(() => elapsed);
    exec
      .mockImplementationOnce(async () => {
        elapsed = 8_000;
        throw Object.assign(new Error('No output specified'), {
          code: 1,
          stderr: Buffer.from(durationListing() + artwork),
        });
      })
      .mockImplementationOnce(async () => {
        elapsed = 18_000;
        throw new Error('broken artwork');
      })
      .mockImplementationOnce(async () => {
        elapsed = 27_000;
        throw new Error('sampling timed out');
      })
      .mockResolvedValueOnce(result());
    expect(await extractLocalVideoCover(input)).toEqual(jpeg);
    expect(exec.mock.calls.map((call) => call[2].timeout)).toEqual([
      10_000, 10_000, 9_000, 3_000,
    ]);
    expect(argsAt(2)).toContain('0:V:0');
    expect(argsAt(3)).not.toContain('-ss');
  });

  it('does not spawn another process after the total deadline', async () => {
    list();
    exec.mockImplementationOnce(async () => {
      now.mockReturnValue(30_000);
      throw new Error('timeout');
    });
    await expect(extractLocalVideoCover(input)).rejects.toThrow(
      'deadline exceeded',
    );
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('counts executable resolution against the deadline', async () => {
    resolveBinary.mockImplementationOnce(async () => {
      now.mockReturnValue(30_001);
      return '/app/media/ffmpeg';
    });
    await expect(extractLocalVideoCover(input)).rejects.toThrow(
      'deadline exceeded',
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    { code: 1, killed: true },
    { code: 'ENOENT' },
    { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
  ])('does not swallow listing process failures: %j', async (failure) => {
    exec.mockRejectedValueOnce(failure);
    await expect(extractLocalVideoCover(input)).rejects.toEqual(failure);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('ignores attached-picture metadata in output mappings', async () => {
    list(durationListing() + 'Output #0:\n' + artwork);
    exec.mockResolvedValueOnce(result());
    await extractLocalVideoCover(input);
    expect(argsAt(1)).toContain('0:V:0');
  });

  it('rejects invalid images after the single first-frame retry', async () => {
    list();
    exec.mockResolvedValue(result(Buffer.from('invalid')));
    await expect(extractLocalVideoCover(input)).rejects.toThrow(
      'no JPEG cover',
    );
    expect(exec).toHaveBeenCalledTimes(3);
  });
});
