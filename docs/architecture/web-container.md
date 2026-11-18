# Web container for Azure App Service

The root `Dockerfile` builds the standalone web app for Linux. Its runtime contains Node 24, the compiled SPA, bundled server and runtime assets, the small launcher dependency, and the pinned FFmpeg binary and notices. It runs as the `node` user, listens on port 8080, and starts existing artifacts directly without Git, pnpm, source files, or a startup build.

## Daily image

[Web container](../../.github/workflows/container.yml) builds `main` every day at **00:37 UTC** and supports manual runs from `main`. Minute 37 avoids the top-of-hour scheduling peak; GitHub schedules can still be delayed. The schedule becomes active after the workflow is merged into the default branch. Pull requests affecting the image build and test it without registry credentials or package-write permission.

The scheduled/manual job builds and tests a `linux/amd64` image before publishing those same local image bytes to GHCR:

- `ghcr.io/microsoft/huabu:daily` points to the latest successful daily/manual build.
- `ghcr.io/microsoft/huabu:sha-<full-sha>-run-<run-id>-<attempt>` identifies one build.
- The run summary records the digest. Pin that digest when deploying to App Service.

The workflow refreshes the base image and OS certificate packages on each run. Local builds use the Microsoft npm proxy by default for managed devices. GitHub-hosted builds explicitly use the public npm registry so a lagging proxy mirror cannot block installation of the locked public packages. Publication uses `GITHUB_TOKEN` with job-scoped `packages: write`; organization policy must permit this. Package visibility and App Service pull authorization are separate registry settings: use anonymous pulls for a public package or configure a dedicated `read:packages` credential for a private package. The workflow does not change package visibility, Azure resources, or the running App Service image.

## Local build and verification

Run from the repository root in PowerShell with a Linux Docker engine:

```powershell
$HuabuRevision = git rev-parse HEAD
docker build --pull --build-arg "SOURCE_REVISION=$HuabuRevision" --tag huabu-web:local .
node scripts/test-web-container.mjs huabu-web:local
```

The smoke check starts the actual image with temporary Basic Auth credentials and a dedicated Docker volume. It verifies the SPA, a JavaScript asset, readiness, encrypted credential persistence across container replacement, and clean SIGTERM exits, then deletes only its own containers and volume. This checks packaging and local identity; it does not prove access to Azure Postgres, Key Vault, Blob Storage, or Entra.

## App Service configuration

Use the Linux image with target port **8080** in the main sitecontainer. For a legacy custom-container app, use `WEBSITES_PORT=8080` instead. The image defaults `HUABU_DATA_DIR=/home/huabu-data` and `HUABU_CONFIG_DIR=/home/huabu-config`. Keep one active Huabu writer.

With `HUABU_STRUCTURED_BACKEND=postgres`, `HUABU_BLOB_BACKEND=azure`, deployment configuration in app settings, and `HUABU_SECRET_KEY` from Key Vault, the container keeps nothing durable on its own filesystem: Workspace records, Space bytes, and [server records](./canvas-storage.md#server-records) — saved credentials, personal and deployment settings, Agent Profiles, device ownership, and credential revocations — live in PostgreSQL and Blob Storage. App Service persistent storage (`WEBSITES_ENABLE_APP_SERVICE_STORAGE`) is then unnecessary; the data directory holds only logs and caches. PostgreSQL refuses to start without `HUABU_SECRET_KEY` rather than generating a key the next container would not have. Back up the database, the Blob container, and the Key Vault secret together.

Supply a stable `HUABU_SECRET_KEY` before creating credentials and preserve it across image replacements. A Disk or SQLite deployment still keeps records in the data directory and needs persistent storage for `HUABU_DATA_DIR`, plus `HUABU_CONFIG_DIR` when the key is generated rather than supplied; Huabu's private-config ownership and mode checks then apply to the mounted filesystem.

Upgrading a PostgreSQL deployment that ran an earlier image with persistent storage: keep the mount for the first start of this version. Startup copies each record from the data directory into PostgreSQL once, never over a newer row, and saves a legacy Ink OCR endpoint into the credential record; after that a deployment with Azure blobs can remove the mount. One that keeps Disk blobs, or SQLite, still keeps data in the data directory and keeps the mount. If that deployment relied on a generated key, first set `HUABU_SECRET_KEY` to the contents of `<HUABU_CONFIG_DIR>/master-key`.

Configure `HUABU_PUBLIC_ORIGIN`, Bubble authenticators, PostgreSQL and Blob settings separately, as described in [deployment security](./deployment-security.md) and [canvas storage](./canvas-storage.md). Authentication is intentionally not disabled by the image. App Service readiness/health probes must account for the configured Host and authentication policy; `/api/deployment/readiness` reports configuration rather than a complete dependency health check.

See [GitHub's GHCR publishing guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry), [Docker's test-before-push pattern](https://docs.docker.com/build/ci/github-actions/test-before-push/), and [App Service container configuration](https://learn.microsoft.com/en-us/azure/app-service/configure-custom-container).
