// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { imageSize } from 'image-size';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./video-ffmpeg.js', () => ({
  getVideoFfmpegPath: async () => process.env.VIDEO_TEST_FFMPEG,
}));

import { extractLocalVideoCover } from './video-cover-decoder.js';

const binary = process.env.VIDEO_TEST_FFMPEG;
// Fixture encoding/color inspection must not expand the production decoder build.
const fixtureBinary = process.env.VIDEO_TEST_FIXTURE_FFMPEG ?? binary;
const exec = promisify(execFile);

describe.skipIf(!binary)('real FFmpeg video covers', () => {
  let dir: string;
  const run = (args: string[]) =>
    exec(
      fixtureBinary ?? 'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', ...args],
      {
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'buffer',
      },
    );
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huabu-video-covers-'));
    await run([
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=96x64:d=0.2',
      '-c:v',
      'mpeg4',
      '-threads',
      '1',
      join(dir, 'plain.mp4'),
    ]);
    await run([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=80x60',
      '-frames:v',
      '1',
      '-threads',
      '1',
      join(dir, 'cover.jpg'),
    ]);
    await run([
      '-i',
      join(dir, 'plain.mp4'),
      '-i',
      join(dir, 'cover.jpg'),
      '-map',
      '0',
      '-map',
      '1',
      '-c',
      'copy',
      '-disposition:v:1',
      'attached_pic',
      join(dir, 'embedded.mp4'),
    ]);
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function assertPixel(bytes: Buffer, channel: number) {
    const output = join(dir, 'result.jpg');
    await writeFile(output, bytes);
    const { stdout } = await run([
      '-i',
      output,
      '-vf',
      'scale=1:1',
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    expect(stdout[channel]).toBeGreaterThan(220);
    expect(stdout[(channel + 1) % 3]).toBeLessThan(30);
  }

  it('prefers red embedded artwork over the blue actual video stream', async () => {
    const cover = await extractLocalVideoCover(join(dir, 'embedded.mp4'));
    expect(imageSize(cover)).toMatchObject({
      width: 80,
      height: 60,
      type: 'jpg',
    });
    await assertPixel(cover, 0);
  });

  it('extracts the first frame of a subsecond video without enlarging it', async () => {
    const cover = await extractLocalVideoCover(join(dir, 'plain.mp4'));
    expect(imageSize(cover)).toMatchObject({ width: 96, height: 64 });
    await assertPixel(cover, 2);
  });

  async function pixels(bytes: Buffer): Promise<Buffer> {
    const output = join(dir, 'sample.jpg');
    await writeFile(output, bytes);
    return (
      await run([
        '-i',
        output,
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ])
    ).stdout;
  }

  async function openingFixture(color: string, duration: number) {
    const input = join(dir, `opening-${color}-${duration}.mp4`);
    await run([
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=160x120:r=10:d=1`,
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=160x120:r=10:d=${duration - 1}`,
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-c:v',
      'mpeg4',
      '-threads',
      '1',
      input,
    ]);
    return input;
  }

  async function assertDetailed(cover: Buffer) {
    expect(imageSize(cover)).toMatchObject({ width: 160, height: 120 });
    const rgb = await pixels(cover);
    let saturated = 0;
    for (let i = 0; i < rgb.length; i += 3) {
      const channels = Array.from(rgb.subarray(i, i + 3));
      if (Math.max(...channels) - Math.min(...channels) > 100) saturated++;
    }
    // The later test pattern has colored detail; black/white opening frames do not.
    expect(saturated / (rgb.length / 3)).toBeGreaterThan(0.3);
  }

  it.each(['black', 'white'])(
    'selects detailed content after a %s opening, not the blank frame at 0.5s',
    async (color) => {
      const input = await openingFixture(color, 12);
      const first = join(dir, `opening-at-half-${color}.jpg`);
      await run(['-ss', '0.5', '-i', input, '-frames:v', '1', first]);
      const blank = await pixels(await readFile(first));
      const mean = blank.reduce((sum, value) => sum + value, 0) / blank.length;
      if (color === 'black') expect(mean).toBeLessThan(10);
      else expect(mean).toBeGreaterThan(240);
      await assertDetailed(await extractLocalVideoCover(input));
    },
  );

  it('flushes a partial thumbnail batch at EOF for a three-second clip', async () => {
    await assertDetailed(
      await extractLocalVideoCover(await openingFixture('black', 3)),
    );
  });

  it('still prefers embedded artwork over later detailed content', async () => {
    const input = await openingFixture('black', 12);
    const embedded = join(dir, 'detailed-with-cover.mp4');
    await run([
      '-i',
      input,
      '-i',
      join(dir, 'cover.jpg'),
      '-map',
      '0',
      '-map',
      '1',
      '-c',
      'copy',
      '-disposition:v:1',
      'attached_pic',
      embedded,
    ]);
    const cover = await extractLocalVideoCover(embedded);
    expect(imageSize(cover)).toMatchObject({ width: 80, height: 60 });
    await assertPixel(cover, 0);
  });

  it.each(['black', 'white'])(
    'retains valid all-%s video rather than rejecting brightness',
    async (color) => {
      const input = join(dir, `all-${color}.mp4`);
      await run([
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=96x64:d=3`,
        '-c:v',
        'mpeg4',
        '-threads',
        '1',
        input,
      ]);
      const cover = await extractLocalVideoCover(input);
      expect(imageSize(cover)).toMatchObject({
        width: 96,
        height: 64,
        type: 'jpg',
      });
      const rgb = await pixels(cover);
      const mean = rgb.reduce((sum, value) => sum + value, 0) / rgb.length;
      if (color === 'black') expect(mean).toBeLessThan(10);
      else expect(mean).toBeGreaterThan(240);
    },
  );

  it('decodes a single frame with known subsecond duration', async () => {
    const input = join(dir, 'single.mp4');
    await run([
      '-i',
      join(dir, 'plain.mp4'),
      '-frames:v',
      '1',
      '-c:v',
      'mpeg4',
      input,
    ]);
    await assertPixel(await extractLocalVideoCover(input), 2);
  });

  it('falls back to the first frame when an unknown-duration single-frame video has nothing after the seek', async () => {
    if (!binary) throw new Error('VIDEO_TEST_FFMPEG is required');
    const input = join(dir, 'unknown-single.webm');
    await run([
      '-i',
      join(dir, 'plain.mp4'),
      '-frames:v',
      '1',
      '-c:v',
      'libvpx-vp9',
      '-threads',
      '1',
      '-live',
      '1',
      input,
    ]);
    // Verify the actual fixture, not merely a mocked duration or seek failure.
    const inspection = await exec(binary, ['-hide_banner', '-i', input], {
      timeout: 10_000,
    }).catch((error: { stderr: string }) => error);
    expect(inspection.stderr).toMatch(/Duration: N\/A/);
    const seek = await exec(
      binary,
      [
        '-hide_banner',
        '-ss',
        '1',
        '-t',
        '6',
        '-i',
        input,
        '-map',
        '0:V:0',
        '-frames:v',
        '1',
        '-c:v',
        'mjpeg',
        '-pix_fmt',
        'yuvj420p',
        '-f',
        'image2pipe',
        'pipe:1',
      ],
      { encoding: 'buffer', timeout: 10_000 },
    );
    expect(seek.stdout).toHaveLength(0);
    await assertPixel(await extractLocalVideoCover(input), 2);
  });

  it('selects from the early bounded batch rather than the majority of a long video', async () => {
    const input = join(dir, 'long-tail.mp4');
    await run([
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=96x64:r=2:d=8',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=96x64:r=2:d=112',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-c:v',
      'mpeg4',
      '-threads',
      '1',
      input,
    ]);
    await assertPixel(await extractLocalVideoCover(input), 2);
  });

  it('keeps a predominantly white slide with dark content as a valid thumbnail', async () => {
    const input = join(dir, 'white-slide.mp4');
    await run([
      '-f',
      'lavfi',
      '-i',
      'color=c=white:s=160x120:d=3',
      '-vf',
      'drawbox=x=20:y=30:w=100:h=8:color=black:t=fill,drawbox=x=20:y=50:w=75:h=5:color=black:t=fill',
      '-c:v',
      'mpeg4',
      '-threads',
      '1',
      input,
    ]);
    const rgb = await pixels(await extractLocalVideoCover(input));
    expect(
      rgb.filter((value) => value > 230).length / rgb.length,
    ).toBeGreaterThan(0.8);
    expect(
      rgb.filter((value) => value < 30).length / rgb.length,
    ).toBeGreaterThan(0.04);
  });

  it('scales large sampled frames before the thumbnail batch', async () => {
    const input = join(dir, 'large-sampled.mp4');
    await run([
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=1920x1080:r=4:d=3',
      '-c:v',
      'mpeg4',
      '-threads',
      '1',
      input,
    ]);
    const cover = await extractLocalVideoCover(input);
    expect(imageSize(cover)).toMatchObject({ width: 1280, height: 720 });
    await assertPixel(cover, 2);
  });

  it('decodes embedded PNG artwork using the minimal build', async () => {
    const png = join(dir, 'cover.png');
    const input = join(dir, 'embedded-png.mp4');
    await run([
      '-i',
      join(dir, 'cover.jpg'),
      '-frames:v',
      '1',
      '-threads',
      '1',
      png,
    ]);
    await run([
      '-i',
      join(dir, 'plain.mp4'),
      '-i',
      png,
      '-map',
      '0',
      '-map',
      '1',
      '-c',
      'copy',
      '-disposition:v:1',
      'attached_pic',
      input,
    ]);
    const cover = await extractLocalVideoCover(input);
    expect(imageSize(cover)).toMatchObject({
      width: 80,
      height: 60,
      type: 'jpg',
    });
    await assertPixel(cover, 0);
  });

  it.each([
    ['mov', 'libx264', 'mov'],
    ['matroska', 'mpeg4', 'mkv'],
    ['avi', 'mpeg4', 'avi'],
    ['flv', 'flv', 'flv'],
    ['mpegts', 'mpeg2video', 'ts'],
    ['mpeg', 'mpeg2video', 'mpg'],
    ['ogg', 'libtheora', 'ogv'],
    ['asf', 'wmv2', 'wmv'],
    ['webm', 'libvpx-vp9', 'webm'],
    ['mp4', 'libx265', 'mp4'],
  ])('decodes a genuine %s/%s fixture', async (format, codec, extension) => {
    const input = join(dir, `container-${format}.${extension}`);
    await run([
      '-i',
      join(dir, 'plain.mp4'),
      '-an',
      '-c:v',
      codec,
      '-threads',
      '1',
      '-f',
      format,
      input,
    ]);
    const cover = await extractLocalVideoCover(input);
    expect(imageSize(cover)).toMatchObject({
      width: 96,
      height: 64,
      type: 'jpg',
    });
    await assertPixel(cover, 2);
  });

  it('extracts attached artwork when no ordinary video stream exists', async () => {
    const input = join(dir, 'artwork-only.mp4');
    await run([
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=8000:cl=mono',
      '-i',
      join(dir, 'cover.jpg'),
      '-map',
      '0:a',
      '-map',
      '1:v',
      '-c:a',
      'aac',
      '-c:v',
      'copy',
      '-t',
      '0.2',
      '-disposition:v:0',
      'attached_pic',
      input,
    ]);
    const cover = await extractLocalVideoCover(input);
    expect(imageSize(cover)).toMatchObject({ width: 80, height: 60 });
    await assertPixel(cover, 0);
  });

  it('scales large frames to at most 1280 while preserving aspect ratio', async () => {
    const input = join(dir, 'large.mp4');
    await run([
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=1920x1080:d=0.1',
      '-c:v',
      'mpeg4',
      '-threads',
      '1',
      input,
    ]);
    expect(imageSize(await extractLocalVideoCover(input))).toMatchObject({
      width: 1280,
      height: 720,
    });
  });

  it('rejects a local-reference playlist disguised as a video container', async () => {
    const input = join(dir, 'playlist.mp4');
    await writeFile(
      input,
      `ffconcat version 1.0\nfile '${join(dir, 'plain.mp4')}'\n`,
    );
    await expect(extractLocalVideoCover(input)).rejects.toThrow();
  });

  it('rejects a remote HLS playlist and corrupt bytes without output', async () => {
    const input = join(dir, 'remote.mp4');
    await writeFile(
      input,
      '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttps://127.0.0.1/private.ts\n#EXT-X-ENDLIST\n',
    );
    await expect(extractLocalVideoCover(input)).rejects.toThrow();
    await writeFile(
      input,
      (await readFile(join(dir, 'plain.mp4'))).subarray(0, 20),
    );
    await expect(extractLocalVideoCover(input)).rejects.toThrow();
  });
});
