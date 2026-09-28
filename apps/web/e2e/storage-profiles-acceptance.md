# Storage-profile browser acceptance

What `playwright.storage-profiles.config.ts` and `storage-profiles.spec.ts` are for, how to run them, and what a passing run does and does not establish.

## Why this suite exists

Phase 6 made `postgres` structured records and `azure` blobs selectable, and made Agent persistence asynchronous underneath. The unit and service suites cover the adapters, the dispatcher, the event log's ordering and the composition lifecycle. None of them can answer the question an operator actually has: **does a deployment on this profile work?**

Three claims are only checkable in a running deployment:

1. Records a user creates through the UI land in the selected structured backend and come back.
2. Bytes a user attaches leave for the selected blob backend and are served again — decoded, not merely requested.
3. An Agent conversation is recovered from the backend, by a **different server process**, well enough that the model can answer from it.

The third is the one that justifies the suite's cost. The turn is driven by a real provider, because a stubbed turn would make the recovery assertion circular: a conversation read back from a database is evidence of durability only if something outside the test produced it.

## What each test does

**`keeps a Space, its nodes and its attached bytes across a server restart`** — creates a Space, writes a Note, uploads a PNG built in-process, then stops the backend and starts it again on the same durable state. After the restart it asserts the Note's text is on the canvas, that exactly one image node reports a non-zero `naturalWidth` (the byte-level claim: the blob backend served the object again), and that the Space is still listed on the home route. Runs on every profile; needs no credentials.

**`recovers an Agent conversation from the backend after a restart`** — gives the Agent a per-run codeword to remember, asks it to create a Note with an exact string, waits for that Note to appear on the canvas, restarts the backend, reloads, and asks for the codeword back. Skipped when no provider credentials were staged.

The codeword is what makes the recovery claim honest. The Note's text is on the Space, so an Agent that lost its history entirely could still recite it by reading the canvas in front of it; the codeword is asserted absent from the Space the server holds, so after the restart there is nowhere but recovered conversation history for it to come from. The second question asks for both, and the reply must contain both.

The restart is the load-bearing step in both. A page reload only shows that the server still remembers; replacing the process is what makes "durable" mean the backend. It is why the backend is spawned by `storage-profile-setup.ts` rather than by Playwright's `webServer` — Playwright owns its children and offers no restart. `storage-profile-server.ts` writes the backend's pid and env to a state file so the worker process can stop and respawn it.

## Running it

The profile is selected the way a deployment selects it. From `apps/web`:

```bash
# Disk records, disk bytes — the default deployment
HUABU_STRUCTURED_BACKEND=disk HUABU_BLOB_BACKEND=disk \
  pnpm exec playwright test --config playwright.storage-profiles.config.ts

# SQLite records, disk bytes
HUABU_STRUCTURED_BACKEND=sqlite HUABU_BLOB_BACKEND=disk \
  pnpm exec playwright test --config playwright.storage-profiles.config.ts

# Postgres records, Azure bytes — the pairing this suite validates
HUABU_STRUCTURED_BACKEND=postgres HUABU_BLOB_BACKEND=azure \
HUABU_POSTGRES_URL='postgresql://user:pass@host:5432/db' \
HUABU_AZURE_STORAGE_CONNECTION_STRING='...' \
HUABU_AZURE_BLOB_CONTAINER=test \
HUABU_AZURE_BLOB_PREFIX=my-run \
  pnpm exec playwright test --config playwright.storage-profiles.config.ts
```

Defaults are `postgres` / `azure`, since those are the profiles under test. Ports are 3121 (backend) and 5293 (web), chosen so a running `pnpm dev` stack is never reused.

**Provider credentials.** The Agent test needs `llm-config.json` and `encrypted-secrets.json`, plus the `HUABU_SECRET_KEY` that decrypts them. `globalSetup` copies the two files from `apps/server/data` (override with `E2E_LLM_CREDENTIALS_FROM`) into the run's throwaway data dir, which teardown deletes. All three are required together: the key is checked before either file is staged, because a data dir holding an `encrypted-secrets.json` the server cannot decrypt makes startup fail outright, which would take the credential-free storage test down with it. When any of the three is missing the Agent test skips and the storage test still runs; it never falls back to a stub.

**Isolation.** Each run gets its own temp data dir, and — on Disk only, where a Workspace is a folder — its own temp Workspace. Teardown removes both and stops the backend. It deliberately does **not** delete what a remote backend holds: give a run against a shared service its own database and its own `HUABU_AZURE_BLOB_PREFIX`, and clean those up yourself.

## What CI runs

`ci.yml` runs this suite on every pull request as `storage-profile-e2e`, in two matrix legs: `disk/disk`, which needs nothing, and `postgres/azure`, the pairing Phase 6 ships. Each leg is its own runner, which is what the next section asks for anyway. Postgres comes from a service container. Azurite is started by hand instead, because the `azurite-blob --blobHost 0.0.0.0 --skipApiVersionCheck` command is not optional against this Azure SDK and a `services:` container cannot express a command; the job pins the digest the Testcontainers suite pins, so the two paths cannot drift. The job also creates the blob container, because `AzureBlobStore.init` validates a container rather than creating one — provisioning it is the operator's job, and on CI the job is the operator.

Both legs report **1 passed, 1 skipped**. The storage test runs; the Agent test skips, because CI has no provider credentials. So what a green CI run establishes is the storage half and the restart harness, on both profiles. The Agent recovery claim — the third of the three above, and the one that justifies the suite's cost — is established only by a by-hand run with credentials staged.

## Run one profile at a time

Driving the matrix as five back-to-back runs in one shell produced one failure that had nothing to do with storage: on the fifth run the Vite dev server answered a lazy route import with `Failed to fetch dynamically imported module: .../CanvasPage.tsx`, and the canvas never mounted. The same profile passed on its own moments later. Five dev servers started and torn down in sequence is the cause; `retries` stays at `0`, as in every other config here, so a flake is visible rather than papered over. Give each profile its own invocation, and its own `E2E_SERVER_PORT` / `E2E_WEB_PORT` if they overlap in time.

## What a pass does not establish

- One Server process at a time. Nothing here exercises two Servers against one database.
- The Agent test asserts that history came back and that the model could use it. It does not assert a particular transcript; a provider is free to word its answer differently, so the assertions are on the codeword and the string the first turn established, not on the model's phrasing.
- A green CI run does not establish the Agent recovery claim. CI has no provider credentials, so that test skips there; see "What CI runs".
- Blob cleanup on Space deletion is covered by the storage suites, not here.
