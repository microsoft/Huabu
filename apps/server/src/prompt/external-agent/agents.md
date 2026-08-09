# Creating and Prompting Agents

Load this guide when work should be handled by a visible Agent conversation instead of direct Space operations. An Agent may use Huabu's default Profile or another available Profile.

## 1. Discover available Profiles

```bash
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/agent/profiles"
```

The `huabu` Profile is the default. Use another returned Profile ID only when its specialization is useful.

The `huabu` Profile uses Huabu's configured model provider. Other Profiles use their own configured runtimes and do not depend on that provider.

## 2. Create and start an Agent

For a Huabu Agent, send the first prompt directly. This creates a visible Agent Node and immediately starts its first turn.

```bash
curl -N -H "$AUTH" -H "Content-Type: text/plain" \
  --data-binary @./prompt.txt "$HUABU_RFS_URL/agent"
```

The response is SSE. Its `created` event contains the new `nodeId`, `threadId`, effective `profileId`, and parent-connection result. Save the `threadId`.

Use JSON to choose a Profile, position, working directory, stable initial instructions, or optional parent conversation:

```bash
curl -N -H "$AUTH" -H "Content-Type: application/json" \
  -H "X-Huabu-Host-Thread-Id: $HUABU_THREAD_ID" \
  --data-binary '{
    "profileId": "profile-id",
    "prompt": "Complete this bounded piece of work.",
    "position": { "x": 1200, "y": 480 },
    "workingDirPath": "/optional/absolute/path",
    "additionalInitialPreamble": "Optional stable role instructions."
  }' "$HUABU_RFS_URL/agent"
```

The parent thread is only a best-effort lineage hint. Missing parents or rejected edges produce a warning in the successful creation response; they never prevent Agent Node creation.

## 3. Create without starting

Use JSON without `prompt` and set `X-Huabu-Agent-Start: false`:

```bash
curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  -H "X-Huabu-Agent-Start: false" \
  --data-binary '{
    "profileId": "profile-id",
    "position": { "x": 1200, "y": 480 }
  }' "$HUABU_RFS_URL/agent"
```

The JSON response contains the same creation metadata. The Agent remains idle until prompted.

## 4. Continue an Agent conversation

```bash
THREAD_ID="thread-..."
curl -N -H "$AUTH" -H "Content-Type: text/plain" \
  --data-binary @./follow-up.txt \
  "$HUABU_RFS_URL/agent/$THREAD_ID/prompt"
```

This endpoint never creates another Agent or changes its Profile. The response is SSE, and closing the connection stops delivery without aborting the durable turn.

An Agent can repeat the same create-and-prompt workflow to delegate recursively. Prefer direct work when another Agent adds no useful specialization, isolation, or parallelism.
