# Delegated and Recursive Agents

Load this guide when the current fixed Agent thread needs to delegate part of its work to another visible Agent. Creating a delegated Agent is not the same as creating a new Task: it remains part of the current working graph.

## 1. Discover selectable Profiles

```bash
curl -fsS -H "$AUTH" "$HUABU_RFS_URL/agent/profiles"
```

Choose an exact returned Profile ID. Never guess an ID.

## 2. Create a delegated Agent

`X-Huabu-Host-Thread-Id` must name the current fixed parent Agent thread. Supply an explicit root-level Canvas position and optional bounded launch overrides.

```bash
curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  -H "X-Huabu-Host-Thread-Id: $HUABU_THREAD_ID" \
  --data-binary '{
    "profileId": "profile-id",
    "position": { "x": 1200, "y": 480 },
    "workingDirPath": "/optional/absolute/path",
    "additionalInitialPreamble": "Optional durable role instructions."
  }' "$HUABU_RFS_URL/agent/create"
```

Creation returns `{ "nodeId", "threadId" }`, creates the parent-to-child Canvas edge, and leaves the child idle. It does not launch a process or submit a prompt.

## 3. Invoke the child

Send the changing work request as the first submission, not as initial preamble.

```bash
CHILD_THREAD_ID="thread-..."
curl -N -H "$AUTH" -H "Content-Type: text/plain" \
  -H "X-Huabu-Thread-Id: $CHILD_THREAD_ID" \
  --data-binary @./child-prompt.txt "$HUABU_RFS_URL/agent"
```

The response is an SSE stream and the child conversation is durable. Closing the HTTP connection stops delivery but does not abort the fixed Agent turn; explicit stop remains the abort path.

The child may repeat the same create-and-invoke sequence using its own `HUABU_THREAD_ID`, so delegation can recurse. Prefer direct work when delegation adds no clear specialization, isolation, or parallel value.
