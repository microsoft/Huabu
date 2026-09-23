// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const sourceVersion = '7.1.3';
// Official tarball authenticated with ffmpeg-devel.asc (FCF986EA15E6E293A5644F10B4322F04D67658D8).
export const sourceSha256 =
  'f0bf043299db9e3caacb435a712fc541fbb07df613c4b893e8b77e67baf3adbe';
export const sourceArchive = `ffmpeg-${sourceVersion}.tar.xz`;
export const sourceUrl = `https://ffmpeg.org/releases/${sourceArchive}`;

export function macConfigureArgs(arch) {
  if (!['arm64', 'x64'].includes(arch))
    throw new Error(`Unsupported macOS FFmpeg architecture: ${arch}`);
  const cpu = arch === 'arm64' ? 'arm64' : 'x86_64';
  return [
    '--target-os=darwin',
    `--arch=${cpu}`,
    `--cc=/usr/bin/clang -arch ${cpu}`,
    '--enable-cross-compile',
    '--disable-autodetect',
    '--disable-gpl',
    '--disable-nonfree',
    '--disable-version3',
    '--disable-doc',
    '--disable-debug',
    '--disable-ffplay',
    '--disable-ffprobe',
    '--disable-x86asm',
    '--disable-asm',
    '--disable-network',
    '--disable-avdevice',
    '--disable-postproc',
    '--disable-shared',
    '--enable-static',
    '--disable-hwaccels',
    '--disable-videotoolbox',
    '--disable-encoders',
    '--enable-encoder=mjpeg',
    '--disable-decoders',
    '--enable-decoder=h264,hevc,vp8,vp9,mpeg4,mpeg1video,mpeg2video,h263,flv,theora,wmv1,wmv2,wmv3,vc1,prores,dvvideo,rawvideo,mjpeg,png,gif,bmp',
    '--disable-demuxers',
    '--enable-demuxer=mov,matroska,avi,flv,mpegts,mpegps,mpegvideo,ogg,asf,image2,image2pipe,jpeg_pipe,png_pipe',
    '--disable-muxers',
    '--enable-muxer=image2,image2pipe',
    '--disable-protocols',
    '--enable-protocol=file,pipe',
    '--disable-filters',
    '--enable-filter=scale,format,null,fps,trim,thumbnail',
    // PNG needs inflate; explicitly link Apple's system zlib, not a downloaded library.
    '--enable-zlib',
    '--extra-cflags=-mmacosx-version-min=11.0',
    '--extra-ldflags=-mmacosx-version-min=11.0',
  ];
}

export function macCacheRoot() {
  return path.join(os.homedir(), 'Library', 'Caches', 'huabu-ffmpeg');
}

export function macBuildDirectory(arch) {
  const recipe = createHash('sha256')
    .update(
      JSON.stringify({
        sourceSha256,
        args: macConfigureArgs(arch),
        revision: 2,
      }),
    )
    .digest('hex')
    .slice(0, 16);
  return path.join(
    macCacheRoot(),
    'builds',
    `${sourceVersion}-${arch}-${recipe}`,
  );
}
