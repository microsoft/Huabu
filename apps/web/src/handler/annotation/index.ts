/**
 * Annotation intent pipeline — barrel export.
 *
 * Three-stage pipeline:
 *   1. Clustering — group strokes into spatial clusters
 *   2. Classification + Context — classify shapes and find nearby nodes
 *   3. Resolution — rule-based fast path or LLM fallback
 */

export { clusterAnnotations } from './clustering';
export { classifyShape } from './classification';
export { extractAnnotationContext } from './context';
export { resolveByRules } from './rules';
