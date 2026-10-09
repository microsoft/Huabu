// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getBundledCapabilityPackages } from './package-loader.js';
import { CapabilityProvisionService } from './provision-service.js';

export const capabilityProvisionService = new CapabilityProvisionService(
  new Map(
    [...getBundledCapabilityPackages()].map(([id, capability]) => [
      id,
      capability.manifest,
    ]),
  ),
);

export {
  getBundledCapabilityPackage,
  readCapabilityPackageFile,
} from './package-loader.js';
export { CapabilityServiceError } from './provision-service.js';
