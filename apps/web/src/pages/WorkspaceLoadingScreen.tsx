// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { Loading } from '../components/Common/Loading';

/** Full-page loading state shared by workspace bootstrap and activation. */
export function WorkspaceLoadingScreen() {
  const { t } = useTranslation();

  return (
    <div className="bg-bg-default h-full">
      <Loading
        variant="brand"
        layout="block"
        size="md"
        message={t('app.loadingWorkspace')}
      />
    </div>
  );
}
