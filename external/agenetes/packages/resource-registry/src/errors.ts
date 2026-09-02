export type ResourceRegistryErrorCode =
  | 'invalid_resource'
  | 'resource_conflict'
  | 'resource_not_found';

/**
 * Raised for every registry precondition failure: an unknown resource
 * (`resource_not_found`), a provider mismatch on replace/withdraw or a
 * create against an ID owned by a different provider (`resource_conflict`),
 * or a malformed record (`invalid_resource`).
 */
export class ResourceRegistryError extends Error {
  constructor(
    readonly code: ResourceRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ResourceRegistryError';
  }
}
