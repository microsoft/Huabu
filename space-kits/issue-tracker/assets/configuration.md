# Issue Tracker Configuration

Edit the JSON below in this existing Note, then set `confirmedByUser: true` and rerun the installer. Only **`codebasePath`** and **`fixingProfileId`** are required upfront; the remaining fields have sensible defaults or are derived from the Git checkout when left `null`:

- `codebasePath` (**required**): absolute path to the local Git repository on the execution device.
- `fixingProfileId` (**required**): external Agent Profile ID (also used for the Coordinator unless `coordinatorProfileId` is set).
- `coordinatorProfileId` (_optional_): defaults to `fixingProfileId` when `null`.
- `repository` (_optional_): `owner/repo` override; when `null`, the Coordinator derives it from `codebasePath` Git remotes (and asks if multiple remotes such as fork `origin` vs `upstream` are ambiguous).
- `worktreeRoot` (_optional_): absolute parent directory for issue worktrees; when `null`, defaults to `<codebasePath>-worktrees`.
- `developmentBaseRef` (_optional_): remote-tracking development base ref; defaults to `"origin/main"`.
- `pullRequestBase` (_optional_): PR target branch name (without remote prefix); defaults to `"main"`.

```json
{
  "schemaVersion": 1,
  "values": {
    "codebasePath": null,
    "fixingProfileId": null,
    "coordinatorProfileId": null,
    "repository": null,
    "worktreeRoot": null,
    "developmentBaseRef": "origin/main",
    "pullRequestBase": "main"
  },
  "confirmedByUser": false
}
```

If your project uses a non-default delivery workflow (for example a Canary or `develop` branch), set `developmentBaseRef` and `pullRequestBase` explicitly. Once configured, the Coordinator enforces those exact refs and fails closed if a configured ref is missing or invalid rather than silently falling back to `main`. Existing execution units preserve their creation-time `Base` and `PR Base` identities.
