{{task}}
{{#selectedNodes}}
## Selected Nodes

{{selectedNodesIntro}}

{{selectedNodesTable}}
{{/selectedNodes}}
{{#sideband}}
## Canvas Tools (Sideband)

You have the Huabu Sideband Tool (HST) available for reading/writing canvas nodes and querying the built-in agent.

Usage: `node ${AGENTLET_SIDEBAND_DIR}/huabu-sideband-tool.mjs <command> [args...]`

Commands:

- `read-node <node-id>` — Download a node's content to a local file, prints file path to stdout
- `write-node --type <type> <content-file>` — Create a new canvas node from a file
- `write-node --id <node-id> <content-file>` — Update an existing node from a file
- `ask-agent "<prompt>"` — Ask the built-in canvas agent a question (supports complex reasoning, spatial queries, multi-node operations)

Run with `--help` for full usage details on each command.
{{/sideband}}
