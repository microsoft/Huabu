# Building Interactive Views

Use an Interactive View when the user needs a durable application-like surface inside the Huabu Canvas. The renderer is untrusted HTML; Huabu owns persistence, live data, navigation, and Agent delivery through a capability bridge.

Do not embed `AGENTLET_TOKEN`, `HUABU_RFS_URL`, API routes, thread IDs, filesystem credentials, or secrets in HTML. Do not call Huabu APIs from the iframe. The iframe may invoke only actions declared when the View is created.

## 1. Discover an existing View

Give each logical View a stable `viewKey` and look it up before creating another one:

```bash
curl -fsS -H "$AUTH" \
  "$HUABU_RFS_URL/interactive-views?viewKey=issue-tracker"
```

The response is `{ "views": [...] }`. Reuse the returned `nodeId`; the Web Node is the View's identity and persistence resource.

## 2. Upload the renderer

Create one self-contained HTML file. Inline CSS and JavaScript are supported; external network resources are not an implicit capability.

```bash
curl -fsS -H "$AUTH" -H "Content-Type: text/html" \
  --data-binary @./issue-tracker.html \
  "$HUABU_RFS_URL/upload/issue-tracker.html"
```

The response path, such as `upload/issue-tracker.html`, is the `rendererArtifact` used in the create request. Huabu imports it into Canvas artifact storage and reclaims the staged upload.

## 3. Create the View

`ownerThreadId` fixes the Agent destination for the View lifetime. Use `HUABU_THREAD_ID` for a View owned by the current Agent.

```bash
cat > /tmp/huabu-view.json <<JSON
{
  "rendererArtifact": "upload/issue-tracker.html",
  "viewKey": "issue-tracker",
  "label": "Issue Tracker",
  "ownerThreadId": "$HUABU_THREAD_ID",
  "state": {
    "schema": {
      "type": "object",
      "properties": {
        "codebasePath": { "type": "string", "maxLength": 4096 },
        "worktreeRoot": { "type": "string", "maxLength": 4096 }
      },
      "required": ["codebasePath", "worktreeRoot"],
      "additionalProperties": false
    },
    "value": { "codebasePath": "", "worktreeRoot": "" }
  },
  "bindings": [
    {
      "bindingId": "tasks",
      "source": { "kind": "canvas.task-store", "recentRunLimit": 50 },
      "refresh": {
        "onMount": true,
        "onFocus": true,
        "pollIntervalMs": 5000
      }
    }
  ],
  "actions": [
    { "actionId": "save-configuration", "kind": "state.replace" },
    { "actionId": "refresh-tasks", "kind": "data.refresh", "bindingId": "tasks" },
    { "actionId": "open-run-node", "kind": "navigation.open-node", "bindingId": "tasks" },
    { "actionId": "open-run-thread", "kind": "navigation.open-thread", "bindingId": "tasks" },
    { "actionId": "approve-run", "kind": "agent.submit" }
  ],
  "position": { "x": 400, "y": 200 },
  "size": { "width": 720, "height": 520 }
}
JSON

curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  --data-binary @/tmp/huabu-view.json \
  "$HUABU_RFS_URL/interactive-views"
```

The state schema supports closed objects, arrays, strings, finite numbers, booleans, null, required properties, enum, and length/range limits. Bounds must be internally consistent, and every required property must be declared. Interactive View state is not a secret store.

Available binding sources are:

- `canvas.task-store`: `{ tasks, runs }`; `recentRunLimit` bounds the newest Runs returned.
- `canvas.nodes`: an array of metadata for the explicitly listed `nodeIds`.

Refresh is Host-scheduled while the View is mounted and visible. `onFocus` refreshes after window focus; `pollIntervalMs` accepts 1000–60000 ms. HTML never supplies a query, URL, or polling callback.

## 4. Connect to the Host bridge

Huabu sends one global `huabu.view.connect` message with a transferred `MessagePort`. Accept only that message from `window.parent`, retain the port, and use it for all later communication:

```html
<script>
  let hostPort;
  let view;
  let sequence = 0;

  window.addEventListener('message', (event) => {
    if (
      event.source !== window.parent ||
      event.data?.type !== 'huabu.view.connect' ||
      event.data?.protocolVersion !== 1 ||
      event.ports.length !== 1 ||
      hostPort
    )
      return;

    hostPort = event.ports[0];
    hostPort.onmessage = ({ data }) => {
      if (data.type === 'huabu.view.bootstrap') {
        view = data;
        render();
      } else if (data.type === 'huabu.view.data') {
        view.data = { ...view.data, ...data.data };
        render();
      } else if (data.type === 'huabu.view.outcome') {
        handleOutcome(data);
      }
    };
    hostPort.start();
  });

  function invoke(actionId, input) {
    if (!hostPort || !view) return;
    hostPort.postMessage({
      type: 'huabu.view.intent',
      protocolVersion: 1,
      nodeId: view.nodeId,
      requestId: `request-${Date.now()}-${sequence++}`,
      actionId,
      ...(input === undefined ? {} : { input }),
    });
  }
</script>
```

Bootstrap contains `{ nodeId, revision, state, data, actions }`. Each `data[bindingId]` contains `{ revision, value, references }`; `references.nodeIds` and `references.threadIds` are the exact Host-authorized navigation targets produced by that binding.

Accepted asynchronous requests receive `pending` followed by `success` or a terminal error; validation and authorization failures may be terminal immediately. Generate a fresh `requestId` for every invocation; replayed IDs are rejected.

## 5. Invoke actions

Replace the complete state using the last observed View revision:

```js
invoke('save-configuration', {
  revision: view.revision,
  value: {
    codebasePath: document.querySelector('#codebase').value,
    worktreeRoot: document.querySelector('#worktrees').value,
  },
});
```

On success, replace the local `view.revision` and `view.state` with the returned values. On `conflict`, reload the View state instead of silently overwriting a newer value.

Refresh one binding with `invoke("refresh-tasks")`.

Open a bound Node with `invoke("open-run-node", { nodeId })`. Open a bound thread with `invoke("open-run-thread", { threadId })`. The target must appear in the granted binding's `references`; arbitrary IDs are rejected.

Deliver a durable structured event to the fixed owner Agent with `invoke("approve-run", { runId, approved: true })`. Huabu persists the event as a `huabu.interactive-view` submission. If the Agent is busy, the current implementation waits for its turn lease for up to five seconds and then returns `thread_busy`.

## 6. Read and update from the Agent

Read the current definition, state, and revision:

```bash
curl -fsS -H "$AUTH" \
  "$HUABU_RFS_URL/interactive-views/$NODE_ID"
```

An Agent may replace state with compare-and-swap:

```bash
curl -fsS -X PUT -H "$AUTH" -H "Content-Type: application/json" \
  --data-binary "{\"revision\":\"$VIEW_REVISION\",\"value\":$COMPLETE_STATE_JSON}" \
  "$HUABU_RFS_URL/interactive-views/$NODE_ID/state"
```

A stale revision returns HTTP 409 with `details.currentRevision` and `details.currentState`. Re-read, reconcile, and submit a new complete value.
