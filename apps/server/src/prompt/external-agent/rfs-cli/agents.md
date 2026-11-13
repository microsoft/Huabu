# Creating and Prompting Agents

Load this guide when work should be handled by a visible Agent conversation instead of direct Space operations. An Agent may use Huabu's default Profile or another available Profile.

## 1. Discover available Profiles

```bash
huabu-rfs agent profiles
```

The entry marked `default: true` is the first selectable external Profile used when Agent creation omits `profileId`. If no entry is marked, explicitly choose an available Profile; do not assume Built-In Pi is an implicit fallback.

The `huabu` Profile uses Huabu's configured model provider. Other Profiles use their own configured runtimes and do not depend on that provider.

## 2. Create and start an Agent

To use the configured default Profile, send the first prompt directly. This creates a visible Agent Node and immediately starts its first turn. An unconfigured or deleted default produces an explicit error rather than selecting another Agent.

```bash
huabu-rfs agent create --text-file ./prompt.txt
```

The response is standard SSE streamed unchanged to stdout. It begins with `: threadId <id>` and a `created` event whose JSON data contains the new `nodeId`, `threadId`, effective `profileId`, and parent-connection result. In the default final mode, subsequent `data:` frames contain the final answer. Ignore heartbeat comments, and treat `event: error` as Agent failure. Save the `threadId`.

Use JSON to choose a Profile, position, working directory, stable initial instructions, or optional parent conversation:

```bash
huabu-rfs agent create --json '{
    "profileId": "profile-id",
    "prompt": "Complete this bounded piece of work.",
    "position": { "x": 1200, "y": 480 },
    "workingDirPath": "/optional/absolute/path",
    "additionalInitialPreamble": "Optional stable role instructions."
  }'
```

The parent thread is only a best-effort lineage hint. Missing parents or rejected edges produce a warning in the successful creation response; they never prevent Agent Node creation.

## 3. Create without starting

Use JSON without `prompt` and select create-only mode:

```bash
huabu-rfs agent create --no-start --json '{
    "profileId": "profile-id",
    "position": { "x": 1200, "y": 480 }
  }'
```

The JSON response contains the same creation metadata. The Agent remains idle until prompted.

## 4. Continue an Agent conversation

If you know the Agent Node but did not retain its creation response, resolve its existing thread association through `INSPECT_NODES`:

```bash
THREAD_ID="$(huabu-rfs query \
  --json '{"type":"INSPECT_NODES","ids":["node-123"]}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).result.nodes[0]?.threadId ?? ""))')"

huabu-rfs agent prompt --text-file ./follow-up.txt "$THREAD_ID"
```

Only Question Nodes with a non-empty existing association include `threadId`; non-Question Nodes and unbound Questions omit it. Inspection is read-only and never creates or realizes Agent state. The prompt endpoint never creates another Agent or changes its Profile. The response is SSE, and closing the connection stops delivery without aborting the durable turn.

For asynchronous handoff, send the prompt yourself and return after durable acceptance rather than waiting for its answer:

```bash
huabu-rfs agent prompt --until-accepted --text-file ./follow-up.txt "$THREAD_ID"
```

This opt-in mode selects `all` events, validates an `accepted` receipt matching the requested Thread, prints its JSON `{ "threadId": "...", "turnStartSeq": 1 }` (and `requestId` when supplied by the server), and disconnects without cancelling execution. It allows up to 60 seconds for submission and acceptance, not for task completion. HTTP success, heartbeat comments, `created`, `meta`, or a Thread announcement are not acceptance. An error, mismatched receipt, timeout, or end of stream without a receipt exits nonzero; the remote outcome can be uncertain, so never blindly resend or replace the Agent. Older servers without this event cannot confirm an acceptance-only handoff. Default commands still stream the full response unchanged.

An Agent can repeat the same create-and-prompt workflow to delegate recursively. Prefer direct work when another Agent adds no useful specialization, isolation, or parallelism.
