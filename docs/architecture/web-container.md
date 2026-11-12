# Web container for Azure App Service

The root `Dockerfile` builds the standalone web app for Linux. Its runtime contains Node 24, the compiled SPA, bundled server and runtime assets, the small launcher dependency, and the pinned FFmpeg binary and notices. It runs as the `node` user, listens on port 8080, and starts existing artifacts directly without Git, pnpm, source files, or a startup build.

## Daily image

[Web container](../../.github/workflows/container.yml) builds `main` every day at **08:37 Asia/Shanghai (00:37 UTC)** and supports manual runs from `main`. GitHub schedules can be delayed. The schedule becomes active after the workflow is merged into the default branch. Pull requests affecting the image build and test it without registry credentials or package-write permission.

The scheduled/manual job builds and tests a `linux/amd64` image before publishing those same local image bytes to GHCR:

- `ghcr.io/microsoft/huabu:daily` points to the latest successful daily/manual build.
- `ghcr.io/microsoft/huabu:sha-<full-sha>-run-<run-id>-<attempt>` identifies one build.
- The run summary records the digest. Pin that digest when deploying to App Service.

The workflow refreshes the base image and OS certificate packages on each run. Builds use the Microsoft npm proxy by default, including local builds on managed devices. Publication uses `GITHUB_TOKEN` with job-scoped `packages: write`; organization policy must permit this. Package visibility and App Service pull authorization are separate registry settings: use anonymous pulls for a public package or configure a dedicated `read:packages` credential for a private package. The workflow does not change package visibility, Azure resources, or the running App Service image.

## Local build and verification

Run from the repository root in PowerShell with a Linux Docker engine:

```powershell
$HuabuRevision = git rev-parse HEAD
docker build --pull --build-arg "SOURCE_REVISION=$HuabuRevision" --tag huabu-web:local .
node scripts/test-web-container.mjs huabu-web:local
```

The smoke check starts the actual image with temporary Basic Auth credentials and a dedicated Docker volume. It verifies the SPA, a JavaScript asset, readiness, encrypted credential persistence across container replacement, and clean SIGTERM exits, then deletes only its own containers and volume. This checks packaging and local identity; it does not prove access to Azure Postgres, Key Vault, Blob Storage, or Entra.

## App Service configuration

Use the Linux image with target port **8080** in the main sitecontainer. For a legacy custom-container app, use `WEBSITES_PORT=8080` instead. The image defaults `HUABU_DATA_DIR=/home/huabu-data` and `HUABU_CONFIG_DIR=/home/huabu-config`. Enable App Service persistent storage with `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` and keep one active Huabu writer.

Supply a stable `HUABU_SECRET_KEY` from Key Vault before creating credentials; preserve it across image replacements. Huabu's private-config ownership and mode checks remain enabled. Verify the actual mounted filesystem's permissions before using file-backed private configuration; environment-managed configuration and a Key Vault encryption key do not require creating a private master-key file on the mount. Include local runtime state in backup/recovery even when records and Space bytes use Postgres and Blob Storage.

Configure `HUABU_PUBLIC_ORIGIN`, Bubble authenticators, PostgreSQL and Blob settings separately, as described in [deployment security](./deployment-security.md) and [canvas storage](./canvas-storage.md). Authentication is intentionally not disabled by the image. App Service readiness/health probes must account for the configured Host and authentication policy; `/api/deployment/readiness` reports configuration rather than a complete dependency health check.

See [GitHub's GHCR publishing guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry), [Docker's test-before-push pattern](https://docs.docker.com/build/ci/github-actions/test-before-push/), and [App Service container configuration](https://learn.microsoft.com/en-us/azure/app-service/configure-custom-container).
