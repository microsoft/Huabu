# Preprocessing lifecycle browser acceptance

Date: 2026-11-23. Branch: `feature/server-owned-preprocessing`. Result: **6 scenarios, 6 passed, 0 failed, 0 skipped, 0 retries**, desktop Chromium, Node 26.13.1 with `NODE_OPTIONS=--no-experimental-webstorage`.

This record replaces the one of 2026-09-15/16. That one certified the page-side preprocessing queue (delayed responses, obsolete requests, load-time backfill); the queue no longer exists, so its scenarios have nothing left to exercise. The server now starts preprocessing where a write is committed, and a page only says that an editor was left (see [node-preprocessing.md](../../../docs/architecture/node-preprocessing.md) §4).

## Harness and isolation

[The spec](./preprocess-lifecycle.spec.ts) uses real Chromium UI interactions, the actual frontend store and content queue, the real server preprocessing jobs, and real Disk-backed topology and content persistence. [The configuration](../playwright.preprocess-lifecycle.config.ts) runs credential-free services on ports 3197/5297 with a temporary workspace, data directory and HOME, and `reuseExistingServer: false`. Browser requests to remote origins and POST requests for agent execution are forbidden; read-only chat metadata is allowed.

No store imports, direct store mutations, or lifecycle calls are injected into the browser. Nothing about preprocessing is synthetic: titles are the ones the server derived and stored, read back over HTTP and after reload. The only injected faults are restore batches that are held or answered with 503; once released they go to the real server unmodified. Every scenario asserts that there are no unexpected page exceptions, console errors or failed HTTP responses. Credentials are absent, so remote LLM enrichment is not validated.

## Verified scenarios

| Scenario                    | Browser assertions                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Note title follows its body | Typing saves the body without changing the title; leaving the editor sends one save marked editing-ended; the server derives the title from the body it holds; title and body survive reload.                    |
| Editing during a restore    | Delete a Note, undo, hold the restoring batch, edit and leave the editor: no content save goes out while the restore is unanswered; after release the body is saved once with the mark and the title follows it. |
| Failing restore             | The restoring batch fails with 503: the edit and the editing-ended mark are kept; after Retry the restore lands, then the body and the mark are sent, and the title follows.                                     |
| Text node                   | A Text node is titled by the server when it is created and again when its inline editor is left.                                                                                                                 |
| A batch asks for nothing    | Moving a PDF inside a Grid makes the server announce no run for either PDF; renaming one is processed by the server, the other is left alone.                                                                    |
| Two pages or none           | With two pages open a write is processed once and both show the result; with no page open a write made over HTTP is processed and stored all the same.                                                           |

## Scope

This is targeted desktop Chromium acceptance, not exhaustive browser/device coverage. Selection of what to preprocess (`commit-trigger.test.ts`), one job per node and write-back (`node-jobs.test.ts`), and the content queue's handling of the mark across restores, conflicts and unload (`canvasStore.restorePersistence.test.ts`, `unloadFlush.test.ts`) are covered at unit level. Video cover write-back has its own browser spec (`video-preprocess.spec.ts`). Real remote extraction and enrichment, Postgres storage and multi-member credentials are not certified here.
