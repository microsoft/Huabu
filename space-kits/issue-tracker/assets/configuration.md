# Issue Tracker Configuration

Edit the JSON below in this existing Note. `null` means REQUIRED, never an inferred default. Paths refer to the intended Agent execution device. Select both Coordinator and Fixing Profiles explicitly (they may use the same or different external Profile IDs). Confirm repository and delivery refs from project evidence, not from the Kit checkout. Supply one evidence description per value, then set `confirmedByUser` only after user confirmation.

```json
{
  "schemaVersion": 1,
  "values": {
    "repository": null,
    "codebasePath": null,
    "worktreeRoot": null,
    "coordinatorProfileId": null,
    "fixingProfileId": null,
    "developmentBaseRef": null,
    "pullRequestBase": null
  },
  "evidence": {},
  "confirmedByUser": false
}
```

Repository format is `owner/repo`. Checkout/worktree paths must be absolute on the selected execution device. The development base is a verified remote-tracking ref; the PR base is its confirmed target branch, which may differ only under an explicit project delivery policy. Evidence should identify the device, relevant Git/config observation and user confirmation, without credentials or personal data.

Structural validation does not establish that a path exists or a device is accessible. The Coordinator must verify these facts on the intended device before creating a worktree. Update this Note when project configuration changes; existing execution units keep their recorded delivery identities.
