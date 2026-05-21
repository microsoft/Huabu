/**
 * @file Type declaration for cytoscape-fcose layout extension.
 *
 * cytoscape-fcose does not ship its own TypeScript definitions.
 * Only the registration function is typed here — layout options are
 * passed via a plain object and validated at runtime by fcose itself.
 */

declare module 'cytoscape-fcose' {
  import type { Ext } from 'cytoscape';

  const fcose: Ext;
  export default fcose;
}
