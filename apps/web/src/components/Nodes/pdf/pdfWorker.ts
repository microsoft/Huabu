// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { pdfjs } from 'react-pdf';

// Import the worker as a Vite static asset so it's served from our own
// origin in every environment (dev / packaged Electron / production
// website). Loading it from a public CDN like unpkg.com fails for
// offline / desktop deployments and previously violated CORS for the
// HTTP variant. `?url` returns a hashed URL Vite emits into the build.

/**
 * Configure the PDF.js worker URL once at module load.
 *
 * Importing this module from any PDF component is enough — re-assigning
 * `workerSrc` is idempotent so duplicate imports are safe.
 */
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Stable options object passed to every `<Document>` instance.
 *
 * `verbosity: ERRORS` silences harmless worker-side notices such as
 * `Warning: TT: undefined function: 21`, which PDF.js emits whenever a
 * TrueType font in the PDF contains hinting opcodes the interpreter does
 * not implement. The warning has no impact on rendering.
 *
 * The reference must remain stable across renders — react-pdf re-loads the
 * document whenever the `options` identity changes — so this is a module
 * constant rather than a per-component literal.
 */
export const PDF_DOCUMENT_OPTIONS = Object.freeze({
  verbosity: pdfjs.VerbosityLevel.ERRORS,
});
