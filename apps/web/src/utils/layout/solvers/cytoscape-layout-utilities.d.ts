/**
 * @file Type declaration for cytoscape-layout-utilities extension.
 *
 * cytoscape-layout-utilities does not ship its own TypeScript definitions.
 * Only the registration function is typed here — instance methods are
 * accessed via `(cy as any).layoutUtilities(options)`.
 */

declare module 'cytoscape-layout-utilities' {
  import type { Ext } from 'cytoscape';

  const layoutUtilities: Ext;
  export default layoutUtilities;
}
