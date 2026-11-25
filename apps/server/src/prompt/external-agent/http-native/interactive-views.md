# Building Interactive Views

Use an Interactive View when the user needs a durable HTML form, control panel, or application-like surface inside the Huabu Space. The renderer is untrusted sandboxed HTML; Huabu owns persistence, live Data Node bindings, View-local state, navigation, and optional Agent delivery through a capability bridge.

Do not embed `HUABU_RFS_TOKEN`, `HUABU_RFS_URL`, API routes, thread IDs, filesystem credentials, or secrets in HTML, Data Nodes, or View state. Do not call Huabu APIs from the iframe. The iframe may invoke only actions declared when the View is created.

## 1. Discover an existing View

Give each logical View a stable `viewKey` and look it up before creating another one:

```bash
curl -fsS -H "$AUTH" \
  "$HUABU_RFS_URL/interactive-views?viewKey=repo-config-form"
```

The response is `{ "views": [...] }`. Reuse the returned `nodeId`; the Web Node is the View's identity and persistence resource.

## 2. Create Data Nodes and upload the renderer

When a form edits structured Space configuration or shared data, store the canonical JSON in one or more standalone Data Nodes (`nodeType: "data"`) first so the Space, Prompt/Skill Frames, Agents, and HTML Views all share one source of truth. Create the Data Node via `POST /execute` (`CREATE_NODES`) to obtain its assigned `nodeId` from `results[].nodes`, and upload one self-contained HTML renderer (`POST /upload/<filename>`):

```bash
curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  -H "X-Huabu-Host-Thread-Id: $HUABU_THREAD_ID" \
  --data-binary '{
    "commands": [{
      "type": "CREATE_NODES",
      "nodes": [{
        "nodeType": "data",
        "data": {
          "label": "Repository Configuration",
          "dataSchema": {
            "type": "object",
            "properties": {
              "codebasePath": { "type": "string", "maxLength": 4096 },
              "confirmedByUser": { "type": "boolean" }
            },
            "required": ["codebasePath", "confirmedByUser"],
            "additionalProperties": false
          },
          "content": "{\"codebasePath\":\"\",\"confirmedByUser\":false}"
        },
        "position": { "x": 400, "y": 200 },
        "size": { "width": 400, "height": 300 }
      }]
    }]
  }' \
  "$HUABU_RFS_URL/execute"

curl -fsS -H "$AUTH" -H "Content-Type: text/html" \
  --data-binary @./repo-config-form.html \
  "$HUABU_RFS_URL/upload/repo-config-form.html"
```

Data Nodes validate `data.content` as JSON against `data.dataSchema` (when present) on every write and reject secret-like keys (`password`, `passwd`, `secret`, `token`, `apiKey`, `privateKey`, `credential`, `credentials`). Inline CSS and JavaScript are supported in the uploaded HTML file; `POST /upload/<filename>` returns `{ "id": "<artifactKey>", "size": ... }` for `rendererArtifact`.

## 3. Create the View

Standalone HTML forms bound to Data Nodes do not require an `ownerThreadId`, Task, or Run. Supply `ownerThreadId` (such as `$HUABU_THREAD_ID`) only when `actions` includes `agent.submit`, and supply `state` only when the View also needs private View-local UI state outside any Data Node:

```bash
cat > /tmp/huabu-view.json <<'JSON'
{
  "rendererArtifact": "artifact-8f2a.html",
  "viewKey": "repo-config-form",
  "label": "Repository Configuration Form",
  "bindings": [
    {
      "bindingId": "config",
      "source": { "kind": "data-node", "nodeId": "node-data-123" },
      "refresh": { "onMount": true, "onFocus": true }
    }
  ],
  "actions": [
    { "actionId": "save-config", "kind": "data.replace", "bindingId": "config" },
    { "actionId": "reload-config", "kind": "data.refresh", "bindingId": "config" },
    { "actionId": "focus-config-node", "kind": "navigation.open-node", "bindingId": "config" }
  ],
  "position": { "x": 860, "y": 200 },
  "size": { "width": 520, "height": 440 }
}
JSON

curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  -H "X-Huabu-Host-Thread-Id: $HUABU_THREAD_ID" \
  --data-binary @/tmp/huabu-view.json \
  "$HUABU_RFS_URL/interactive-views"
```

Available binding sources (`bindings[].source`) are:

- `data-node`: `{ "kind": "data-node", "nodeId": "<dataNodeId>" }` — binds one specific Data Node as a whole JSON value. Runtime `data[bindingId].value` is `{ "status": "ready", "nodeId", "label", "value", "schema" }`, `{ "status": "missing", "nodeId" }` if deleted, or `{ "status": "invalid", "nodeId", "label", "error" }` if invalid, with `data[bindingId].revision` equal to that Data Node's current `rev`. Huabu automatically pushes live `huabu.view.data` updates while the View is mounted whenever a bound Data Node changes on the Space.
- `canvas.task-store`: `{ "kind": "canvas.task-store", "recentRunLimit": 50 }` — delivers `{ tasks, runs }`.
- `canvas.nodes`: `{ "kind": "canvas.nodes", "nodeIds": ["..."] }` — delivers summary metadata for the listed `nodeIds`.

Available action grants (`actions[]`) are:

- `data.replace` (`bindingId` targeting a `data-node` binding): replaces the bound Data Node's complete JSON value using compare-and-swap against `data[bindingId].revision` and `dataSchema`.
- `data.refresh` (optional `bindingId`): refreshes one binding or all bindings.
- `state.replace`: replaces View-local `state` using compare-and-swap against `view.revision`.
- `navigation.open-node` (`bindingId`): focuses a Node listed in that binding's `references.nodeIds`.
- `navigation.open-thread` (`bindingId`): opens a conversation listed in that binding's `references.threadIds`.
- `agent.submit`: delivers a durable structured `huabu.interactive-view` event to `ownerThreadId` (requires `ownerThreadId` at View creation).

Both `dataSchema` and View `state.schema` support closed objects (`additionalProperties: false`), arrays, strings, finite numbers, booleans, null, required properties, `enum`, and length/range limits. Refresh (`onFocus`, `pollIntervalMs` 1000–60000 ms) is Host-scheduled while the View is mounted and visible.

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

Bootstrap contains `{ nodeId, revision, state, data, actions }`. Each `data[bindingId]` contains `{ revision, value, references }`; `references.nodeIds` and `references.threadIds` are the exact Host-authorized navigation targets produced by that binding. Generate a fresh `requestId` for every invocation; accepted asynchronous requests emit `pending` followed by `success` or a terminal error.

## 5. Invoke actions

Replace a bound Data Node's complete JSON value using that binding's last observed `revision`:

```js
const configBinding = view.data.config;
if (configBinding?.value?.status === 'ready') {
  invoke('save-config', {
    revision: configBinding.revision,
    value: {
      ...configBinding.value.value,
      codebasePath: document.querySelector('#codebase').value,
      confirmedByUser: document.querySelector('#confirmed').checked,
    },
  });
}
```

On `success`, merge `outcome.data` into `view.data` (updating `view.data.config.revision` and `value`). On `conflict`, `outcome.details` includes `currentRevision` and `currentValue` so the form can display a conflict prompt without losing the user's draft; if `configBinding.value.status === "missing"`, render a missing-data notice instead of crashing.

Use `invoke("reload-config")` for `data.refresh`, `invoke("focus-config-node", { nodeId })` for `navigation.open-node`, `invoke(stateActionId, { revision: view.revision, value })` for View-local `state.replace`, and `invoke(submitActionId, payload)` for `agent.submit`.

## 6. Read and update from the Agent

Read and update bound Data Nodes with ordinary RFS operations (`GET /download/<dataNodeId>` returns `dataSchema` in YAML frontmatter plus the JSON body and `ETag`; `POST /execute` `MERGE_NODE_DATA` writes updated JSON with unquoted `ETag` in `expectRev`):

```bash
curl -fsS -H "$AUTH" -D /tmp/data-headers.txt -o /tmp/config.md \
  "$HUABU_RFS_URL/download/node-data-123"

curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  -H "X-Huabu-Host-Thread-Id: $HUABU_THREAD_ID" \
  --data-binary '{
    "commands": [{
      "type": "MERGE_NODE_DATA",
      "patches": [{
        "nodeId": "node-data-123",
        "expectRev": "3d7e",
        "patch": { "content": "{\"codebasePath\":\"/repo\",\"confirmedByUser\":true}" }
      }]
    }]
  }' \
  "$HUABU_RFS_URL/execute"
```

Inspect an Interactive View's definition or replace its optional View-local `state`:

```bash
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/interactive-views/$NODE_ID"

curl -fsS -X PUT -H "$AUTH" -H "Content-Type: application/json" \
  --data-binary "{\"revision\":\"$VIEW_REVISION\",\"value\":$COMPLETE_STATE_JSON}" \
  "$HUABU_RFS_URL/interactive-views/$NODE_ID/state"
```

A stale revision returns HTTP 409 (`conflict`) with the latest revision and value. Re-read, reconcile, and submit a complete updated value.
