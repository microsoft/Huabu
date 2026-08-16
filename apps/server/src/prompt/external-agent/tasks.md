# Durable Tasks and Runs

Load this guide only when the user explicitly wants durable long-horizon work. Ordinary discussion and direct Space edits do not need a Task.

Every Task belongs to the current Space, stores one durable goal, and creates one static Task Note. A Task may have multiple Runs. Each Run snapshots the Task goal and creates a fresh visible root Agent Node and thread.

## 1. Discover available Profiles

Task creation requires an exact available Agent Profile ID. Never guess one.

```bash
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/agent/profiles"
```

The response is `{ "profiles": [{ "id", "alias" }] }`. Use a Profile clearly selected by the user or current context; when several are plausible, ask the user.

## 2. Create the Task

Choose a root-level position for the static Task Note using the root skill's layout basics.

```bash
curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  --data-binary '{
    "goal": "Investigate and fix the issue",
    "defaultRootProfileId": "profile-id",
    "position": { "x": 800, "y": 360 }
  }' "$HUABU_RFS_URL/task/create"
```

The response is `{ "task": { "taskId", "canvasId", "goal", "defaultRootProfileId", "anchorNodeId", "createdAt" } }`. Save `taskId`. Creation does not start execution.

## 3. Start a Run

An empty request uses the Task's default Profile. `rootProfileId` may select another exact Profile for this Run. `workingDirPath` must be absolute. `additionalInitialPreamble` contains stable role instructions, not changing Task input.

```bash
TASK_ID="task-..."
curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  --data-binary '{
    "workingDirPath": "/optional/absolute/path",
    "additionalInitialPreamble": "Optional durable root-Agent instructions."
  }' "$HUABU_RFS_URL/task/$TASK_ID/run/create"
```

The response contains the canonical Run after its visible root Agent Node is created and its first turn begins.

A failed launch may intentionally retain an inspectable `pending` Run and return its Run, root node, or root thread IDs in the error. Do not blindly retry: inspect the returned identities and visible Space state first.

## 4. Complete a Run

Completion is an explicit workflow decision; an Agent turn ending does not complete its Run. Only a `running` Run can become `completed`.

```bash
RUN_ID="run-..."
curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  --data-binary '{
    "message": "PR #100 created: https://github.com/microsoft/Huabu/pull/100"
  }' "$HUABU_RFS_URL/task/$TASK_ID/run/$RUN_ID/complete"
```

`message` is optional caller-owned context, trimmed by the server, and stored as untrusted text without interpreting issue, pull-request, or URL semantics. The response is `{ "run": { ... } }` with `status: "completed"` and immutable `completion.completedAt` plus the optional `completion.message`.

Repeating the request with the same normalized message is idempotent and preserves the original completion timestamp. Completing a `pending` Run or retrying a completed Run with a different message returns `409 Conflict`.

For delegation performed by the root Agent, load `GET skill/agents`.
