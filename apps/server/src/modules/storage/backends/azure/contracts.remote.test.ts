// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { openAzureTestStore } from './test-support.js';
import { describeBlobStoreContract } from '../../ports/contracts/blob-store.contract.js';

describeBlobStoreContract('Azure Blob (Azurite)', openAzureTestStore);
