import { pdfjs } from 'react-pdf';

/**
 * Configure the PDF.js worker URL once at module load.
 *
 * Importing this module from any PDF component is enough — re-assigning
 * `workerSrc` is idempotent so duplicate imports are safe.
 */
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

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
