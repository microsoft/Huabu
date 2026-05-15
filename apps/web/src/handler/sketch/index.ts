/**
 * Sketch intent pipeline — barrel export.
 *
 * Pipeline (post-simplification):
 *   1. clusterSketches — group strokes into spatial clusters
 *   2. extractSketchContext — collect IDs of nearby/enclosed nodes + edges
 *   3. recognizeSketchCommands (server) — vision LLM with on-demand
 *      `read` (for node content), `inspect_nodes` (for node layout /
 *      style / spatial relations), and `inspect_edges` (for edge style)
 *      tool access produces the canvas command batch
 *
 * The previous rule-based shape classifier and dispatch layer have been
 * removed: the LLM now decides the intent purely from the screenshot plus
 * a minimal ID payload, with tool calls used to fetch any required node
 * content. This eliminated the high false-positive rate of the rule path.
 */

export { clusterSketches } from './sketchClustering';
export { extractSketchContext } from './sketchContext';
