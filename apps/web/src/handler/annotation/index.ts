/**
 * Annotation intent pipeline — barrel export.
 *
 * Pipeline (post-simplification):
 *   1. clusterAnnotations — group strokes into spatial clusters
 *   2. extractAnnotationContext — collect IDs of nearby/enclosed nodes + edges
 *   3. recognizeAnnotationCommands (server) — vision LLM with on-demand
 *      `get_node_detail` tool access produces the canvas command batch
 *
 * The previous rule-based shape classifier and dispatch layer have been
 * removed: the LLM now decides the intent purely from the screenshot plus
 * a minimal ID payload, with tool calls used to fetch any required node
 * content. This eliminated the high false-positive rate of the rule path.
 */

export { clusterAnnotations } from './clustering';
export { extractAnnotationContext } from './context';
