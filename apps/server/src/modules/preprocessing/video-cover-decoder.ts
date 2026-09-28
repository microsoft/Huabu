// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import { getVideoFfmpegPath } from './video-ffmpeg.js';

const exec = promisify(execFile);
const LIMIT = 8 * 1024 * 1024;
const TOTAL_TIMEOUT = 30_000;
const SCALE =
  "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease";
// One early batch, not a uniform sample of the entire video. Trim before
// thumbnail so EOF flushes partial batches without decoding the rest of a file.
const SAMPLE_FILTER =
  `trim=duration=6,fps=fps=2:round=near:eof_action=pass,${SCALE},` +
  'format=yuv420p,trim=end_frame=12,thumbnail=n=12';
const containers =
  'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,flv,mpegts,mpeg,ogg,asf';

function inputArgs(path: string, seek?: number): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-threads',
    '1',
    '-protocol_whitelist',
    'file,pipe',
    '-format_whitelist',
    containers,
    ...(seek === undefined ? [] : ['-ss', String(seek), '-t', '6']),
    '-i',
    path,
  ];
}

const options = {
  shell: false as const,
  killSignal: 'SIGKILL' as const,
  maxBuffer: LIMIT,
  encoding: 'buffer' as const,
  windowsHide: true,
  env: { ...process.env, AV_LOG_FORCE_NOCOLOR: '1' },
};

function processOptions(deadline: number, cap: number, reserve = 0) {
  const remaining = Math.floor(deadline - performance.now() - reserve);
  if (remaining <= 0) throw new Error('FFmpeg cover deadline exceeded');
  return { ...options, timeout: Math.min(remaining, cap) };
}

/** FFmpeg 4.x has no disposition stream selector. Inspect its input listing instead. */
async function inspectInput(
  binary: string,
  path: string,
  deadline: number,
): Promise<{ embedded?: string; duration?: number }> {
  let listing = '';
  try {
    const result = await exec(
      binary,
      inputArgs(path),
      processOptions(deadline, 10_000),
    );
    listing = result.stderr.toString();
  } catch (error) {
    // FFmpeg prints stream information then exits 1 because no output was
    // specified. It does not transcode an audio track or an entire video just
    // to list streams. Timeouts / spawn / buffer errors must still fail.
    const failure = error as {
      code?: unknown;
      killed?: boolean;
      stderr?: Buffer;
    };
    if (failure.code !== 1 || failure.killed) throw error;
    listing = failure.stderr?.toString() ?? '';
  }
  // Never parse output mappings or arbitrary metadata as an input stream.
  const inputListing = listing.split(/Stream mapping:|Output #/)[0] ?? '';
  const embedded =
    /^\s*Stream #0:(\d+)(?:\[[^\]\r\n]*\])?(?:\([^\r\n)]*\))?: Video:[^\r\n]*\(attached pic\)/m.exec(
      inputListing,
    )?.[1];
  const time = /^ {2}Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?), start:/m.exec(
    inputListing,
  );
  const duration = time
    ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])
    : undefined;
  return {
    embedded,
    duration:
      duration !== undefined && Number.isFinite(duration) && duration > 0
        ? duration
        : undefined,
  };
}

/** Decode a leased local artifact only; no URL or caller-selected decoder options. */
export async function extractLocalVideoCover(path: string): Promise<Buffer> {
  const deadline = performance.now() + TOTAL_TIMEOUT;
  const binary = await getVideoFfmpegPath();
  const { embedded, duration } = await inspectInput(binary, path, deadline);
  const decode = async (map: string, seek?: number) => {
    const { stdout } = await exec(
      binary,
      [
        ...inputArgs(path, seek),
        '-map',
        map,
        '-an',
        '-sn',
        '-dn',
        '-frames:v',
        '1',
        '-vf',
        seek === undefined ? SCALE : SAMPLE_FILTER,
        '-filter_threads',
        '1',
        '-threads',
        '1',
        '-c:v',
        'mjpeg',
        '-q:v',
        '3',
        '-f',
        'image2pipe',
        'pipe:1',
      ],
      processOptions(
        deadline,
        seek === undefined ? 10_000 : 12_000,
        seek === undefined ? 0 : 3_000,
      ),
    );
    if (
      stdout.length < 3 ||
      stdout[0] !== 0xff ||
      stdout[1] !== 0xd8 ||
      stdout[2] !== 0xff
    ) {
      throw new Error('FFmpeg produced no JPEG cover');
    }
    return stdout;
  };
  if (embedded !== undefined) {
    try {
      return await decode(`0:${embedded}`);
    } catch {
      // Broken artwork must not prevent an ordinary video cover.
    }
  }
  // Uppercase V explicitly excludes attached pictures and thumbnails.
  if (duration === undefined || duration > 1) {
    try {
      return await decode(
        '0:V:0',
        duration === undefined ? 1 : Math.min(1, duration / 10),
      );
    } catch {
      // Seek/EOF/fps can yield nothing for short, sparse, or misreported media.
      // Keep a first-frame attempt within the original deadline, not a new one.
    }
  }
  return decode('0:V:0');
}
