// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getBundledServicePackages } from './package-loader.js';
import { ServiceProvisioner } from './provisioner.js';

export const serviceProvisioner = new ServiceProvisioner(
  new Map(
    [...getBundledServicePackages()].map(([id, service]) => [
      id,
      service.manifest,
    ]),
  ),
);

export {
  getBundledServicePackage,
  readServicePackageFile,
} from './package-loader.js';
export { ServiceProvisionError } from './provisioner.js';
