// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Minimal MHTML (MIME HTML / RFC 2557) writer + reader.
 *
 * The fetch-once web-node pipeline saves a snapshot of every remote URL
 * as a single-part MHTML artifact. The on-disk format is:
 *
 *     MIME-Version: 1.0
 *     From: <Saved by Huabu>
 *     Subject: <title>
 *     Date: <RFC 2822 date>
 *     Snapshot-Content-Location: <original URL>
 *     Content-Type: multipart/related;
 *                   type="text/html";
 *                   boundary="----=_NextPart_<id>"
 *
 *     ------=_NextPart_<id>
 *     Content-Type: text/html
 *     Content-Transfer-Encoding: quoted-printable
 *     Content-Location: <original URL>
 *
 *     <quoted-printable HTML>
 *     ------=_NextPart_<id>--
 *
 * Chromium recognises this on its own (drag a `.mhtml` file into the
 * browser and it renders). For iframe rendering we go the other way:
 * `extractHtmlFromMhtml` strips the multipart wrapper, decodes
 * quoted-printable, and the artifact-serve route returns the inner
 * HTML as `text/html` so the iframe can render it without needing any
 * special MHTML handler.
 */

const BOUNDARY_PREFIX = '----=_NextPart_';

function encodeQuotedPrintable(input: string): string {
  // Encode the body as UTF-8 then quoted-printable. We:
  //   • escape `=` and any byte outside ASCII 33..126 (except space/tab)
  //   • soft-wrap lines at 76 chars with a trailing `=`
  // Trailing whitespace at the end of a line must be encoded; we do that
  // implicitly because newlines are emitted as literal CRLF separators
  // between chunks, not by encoding the byte stream's own `\n`.
  const bytes = Buffer.from(input, 'utf8');
  let out = '';
  let lineLen = 0;
  const append = (chunk: string) => {
    if (lineLen + chunk.length > 75) {
      out += '=\r\n';
      lineLen = 0;
    }
    out += chunk;
    lineLen += chunk.length;
  };

  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === 0x0a) {
      // Source LF → hard line break in encoded output.
      out += '\r\n';
      lineLen = 0;
      continue;
    }
    if (byte === 0x0d) {
      // CR; if followed by LF, skip — the LF branch handles the break.
      if (bytes[i + 1] === 0x0a) continue;
      out += '\r\n';
      lineLen = 0;
      continue;
    }
    if (byte === 0x09 || (byte >= 0x20 && byte <= 0x7e && byte !== 0x3d)) {
      // Printable ASCII (sans `=`) goes through verbatim.
      append(String.fromCharCode(byte));
    } else {
      // Everything else → `=HH` triplet.
      append(`=${byte.toString(16).toUpperCase().padStart(2, '0')}`);
    }
  }
  return out;
}

function decodeQuotedPrintable(input: string): string {
  // Reverse of the above. Strip soft line breaks (`=` at end of line) and
  // decode `=HH` triplets back to bytes; everything else passes through.
  const out: number[] = [];
  // Normalise CR/CRLF to LF; we'll treat any standalone LF as a real break.
  const normalised = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let i = 0;
  while (i < normalised.length) {
    const ch = normalised[i];
    if (ch === '=') {
      // Soft break: `=` immediately followed by newline.
      if (normalised[i + 1] === '\n') {
        i += 2;
        continue;
      }
      const hex = normalised.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 3;
        continue;
      }
      // Lone `=` — keep verbatim.
      out.push(0x3d);
      i += 1;
      continue;
    }
    if (ch === '\n') {
      out.push(0x0d, 0x0a);
      i += 1;
      continue;
    }
    out.push(ch.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(out).toString('utf8');
}

function rfc2822Date(now = new Date()): string {
  // Minimal RFC 2822 date string. Email clients are lenient; this also
  // matches what Chromium emits in its own MHTML saves.
  return now.toUTCString();
}

function escapeHeader(value: string): string {
  // MIME headers are 7-bit ASCII; collapse control chars and CRLF so a
  // hostile title can't inject a fake header. Subjects with non-ASCII
  // are written as-is — every reader we care about (Chromium, our own
  // extractor) tolerates UTF-8 in headers.
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Wrap raw HTML as a single-part MHTML buffer suitable for writing to
 * disk as an `.mhtml` artifact.
 *
 * `sourceUrl` is recorded as `Snapshot-Content-Location` (top-level) and
 * `Content-Location` (inner part) so Chromium can resolve relative URLs
 * inside the document when it opens the file directly. When the iframe
 * path is used instead, the artifact-serve route injects a `<base href>`
 * tag for the same purpose.
 */
export function wrapAsMhtml(
  html: string,
  sourceUrl: string,
  title?: string,
): Buffer {
  const boundary = `${BOUNDARY_PREFIX}${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const safeTitle = escapeHeader(title ?? sourceUrl);
  const safeUrl = escapeHeader(sourceUrl);
  const date = rfc2822Date();

  const headers = [
    'MIME-Version: 1.0',
    'From: <Saved by Huabu>',
    `Subject: ${safeTitle}`,
    `Date: ${date}`,
    `Snapshot-Content-Location: ${safeUrl}`,
    `Content-Type: multipart/related; type="text/html"; boundary="${boundary}"`,
    '',
    '',
  ].join('\r\n');

  const partHeaders = [
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    `Content-Location: ${safeUrl}`,
    '',
    '',
  ].join('\r\n');

  const body = encodeQuotedPrintable(html);

  const part = `--${boundary}\r\n${partHeaders}${body}\r\n--${boundary}--\r\n`;

  return Buffer.from(headers + part, 'utf8');
}

/**
 * Inverse of {@link wrapAsMhtml}: pull the first `text/html` part out of
 * a single-part MHTML buffer and return the decoded HTML string.
 *
 * Returns `null` when the input is malformed or has no HTML part — the
 * artifact-serve route falls back to serving the raw bytes in that case.
 */
export function extractHtmlFromMhtml(buffer: Buffer): {
  html: string;
  sourceUrl: string | null;
} | null {
  // Cap parsing input so a hostile / corrupted artifact can't blow up
  // memory. 25 MiB is well above any realistic single-page snapshot.
  const text = buffer.subarray(0, 25 * 1024 * 1024).toString('utf8');

  const boundaryMatch = /boundary="?([^"\r\n;]+)"?/i.exec(text);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1];

  const topLocationMatch = /^Snapshot-Content-Location:\s*(.+)$/im.exec(text);
  const fallbackUrl = topLocationMatch ? topLocationMatch[1].trim() : null;

  // Split into parts; first chunk is the multipart preamble (skip it).
  const parts = text.split(`--${boundary}`).slice(1);
  for (const partRaw of parts) {
    // Boundary terminator is `--` after the boundary marker — skip those.
    if (partRaw.startsWith('--')) break;
    const part = partRaw.replace(/^\r?\n/, '');
    const sepIdx = part.search(/\r?\n\r?\n/);
    if (sepIdx === -1) continue;
    const rawHeaders = part.slice(0, sepIdx);
    const rawBody = part.slice(sepIdx).replace(/^\r?\n\r?\n/, '');
    const headers = Object.fromEntries(
      rawHeaders
        .split(/\r?\n/)
        .map((line) => line.split(':'))
        .filter((kv) => kv.length >= 2)
        .map((kv) => [
          kv[0].trim().toLowerCase(),
          kv.slice(1).join(':').trim(),
        ]),
    );
    const contentType = (headers['content-type'] ?? '').toLowerCase();
    if (!contentType.startsWith('text/html')) continue;

    const encoding = (headers['content-transfer-encoding'] ?? '')
      .toLowerCase()
      .trim();
    // The MIME wrapper adds a CRLF between the encoded body and the
    // closing boundary marker. `split('--<boundary>')` discards the
    // marker but leaves that separator behind — strip exactly one
    // trailing CRLF so the decoded body matches the original byte for
    // byte. Anything more (e.g. a `\r\n--`) is the residue of a
    // malformed split and is also dropped.
    const bodyTrimmed = rawBody.replace(/\r?\n(?:--\s*)?$/, '');
    const location = headers['content-location'] ?? null;

    let html: string;
    if (encoding === 'quoted-printable') {
      html = decodeQuotedPrintable(bodyTrimmed);
    } else if (encoding === 'base64') {
      html = Buffer.from(bodyTrimmed.replace(/\s+/g, ''), 'base64').toString(
        'utf8',
      );
    } else {
      html = bodyTrimmed;
    }
    return { html, sourceUrl: location ?? fallbackUrl };
  }
  return null;
}

/**
 * Inject a `<base href>` tag into the document `<head>` so relative URLs
 * inside the snapshot resolve against the original site instead of the
 * artifact-serve URL we're loading from.
 *
 * If the document already declares a `<base>` we leave it alone — the
 * author's choice wins. If there's no `<head>`, we wrap the content in
 * one so well-formed downstream parsers can still find the base.
 */
export function injectBaseHref(html: string, baseHref: string): string {
  if (/<base\b/i.test(html)) return html;
  const tag = `<base href="${baseHref.replace(/"/g, '&quot;')}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (match) => `${match}${tag}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(
      /<html\b[^>]*>/i,
      (match) => `${match}<head>${tag}</head>`,
    );
  }
  return `<head>${tag}</head>${html}`;
}
