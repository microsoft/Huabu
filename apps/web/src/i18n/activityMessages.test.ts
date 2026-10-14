// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import enCommon from './resources/en/common.json';
import zhCNCommon from './resources/zh-CN/common.json';

describe('activity message counts', () => {
  it.each([
    ['activitySteps', '{{count}} step', '{{count}} steps', '{{count}} 个步骤'],
    [
      'activityToolCalls',
      '{{count}} tool call',
      '{{count}} tool calls',
      '{{count}} 次工具调用',
    ],
    [
      'activityCompletedSteps',
      'Completed {{count}} step',
      'Completed {{count}} steps',
      '已完成 {{count}} 个步骤',
    ],
    [
      'activityInterruptedSteps',
      'Interrupted · {{count}} step',
      'Interrupted · {{count}} steps',
      '已中断 · {{count}} 个步骤',
    ],
    [
      'activityErrorSteps',
      'Error · {{count}} step',
      'Error · {{count}} steps',
      '发生错误 · {{count}} 个步骤',
    ],
    [
      'activityFilesChanged',
      'Changed {{count}} file',
      'Changed {{count}} files',
      '已更改 {{count}} 个文件',
    ],
  ] as const)(
    'localizes %s without falling back to another language',
    async (key, one, other, chinese) => {
      const translations = createInstance();
      await translations.init({
        resources: {
          en: { common: enCommon },
          'zh-CN': { common: zhCNCommon },
        },
        defaultNS: 'common',
        fallbackLng: false,
      });
      for (const count of [0, 1, 2]) {
        expect(translations.t(`messages.${key}`, { lng: 'en', count })).toBe(
          (count === 1 ? one : other).replace('{{count}}', String(count)),
        );
        expect(translations.t(`messages.${key}`, { lng: 'zh-CN', count })).toBe(
          chinese.replace('{{count}}', String(count)),
        );
      }
    },
  );
});
