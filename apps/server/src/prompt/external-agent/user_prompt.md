## Request

{{task}}
{{#selectedNodes}}

## Selected Nodes

The user selected the canvas nodes below. Read any you need with the Huabu Reachback Tool (`read-node <node-id>`); update them with `write-node --id <node-id>`.

{{selectedNodesTable}}
{{/selectedNodes}}
{{#neighbourhood}}

## Canvas Neighbourhood

The request was anchored at a specific node on the canvas. Use this neighbourhood to disambiguate references like "this" or "the one above", and to choose sensible positions when creating nodes nearby.

{{neighbourhoodBody}}
{{/neighbourhood}}
