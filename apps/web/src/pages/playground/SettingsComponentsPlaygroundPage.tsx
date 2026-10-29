// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AlertTriangle, Check, Copy, RotateCcw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/Common/Button';
import { cn } from '@/components/Common/cn';
import { CommandBlock } from '@/components/Common/CommandBlock';
import { EmptyState } from '@/components/Common/EmptyState';
import { Input } from '@/components/Common/Input';
import { Loading } from '@/components/Common/Loading';
import { Select } from '@/components/Common/Select';
import { TabGroup } from '@/components/Common/TabGroup';
import { TextInput, textInputClassName } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { Toggle } from '@/components/Common/Toggle';
import { ApiKeyRow } from '@/components/Settings/Common/ApiKeyRow';
import { SettingControl } from '@/components/Settings/Common/SettingControl';
import { SettingLabel } from '@/components/Settings/Common/SettingLabel';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { SettingSection } from '@/components/Settings/Common/SettingSection';
import { SettingSubGroup } from '@/components/Settings/Common/SettingSubGroup';

import './SettingsComponentsPlaygroundPage.css';

type FeedbackState = 'idle' | 'saving' | 'saved' | 'error';

function Specimen({
  id,
  title,
  source,
  description,
  draft = false,
  children,
}: {
  id: string;
  title: string;
  source: string;
  description: string;
  draft?: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} className="settings-specimen" aria-label={title}>
      <header className="border-edge-default border-b px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-fg-default text-sm font-semibold">{title}</h2>
          <span
            className={cn('text-xs', draft ? 'text-info-fg' : 'text-fg-subtle')}
          >
            {draft ? '拟议组合 · 尚未抽取' : '复用现有组件'}
          </span>
        </div>
        <p className="text-fg-muted mt-1 text-xs">{description}</p>
        <p className="text-fg-subtle mt-2 font-mono text-[11px] break-all">
          {source}
        </p>
      </header>
      <div className="settings-specimen-stage">{children}</div>
    </section>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="text-fg-subtle mb-2 text-[11px]">{children}</p>;
}

function Feedback({ state }: { state: FeedbackState }) {
  if (state === 'idle') return null;
  return (
    <div
      role={state === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex min-w-0 items-start gap-1.5 text-xs',
        state === 'error' ? 'text-danger-fg' : 'text-fg-muted',
        state === 'saved' && 'text-success-fg',
      )}
    >
      {state === 'saving' ? (
        <Loading layout="inline" size="xs" />
      ) : state === 'error' ? (
        <AlertTriangle size={14} className="shrink-0" aria-hidden />
      ) : (
        <Check size={14} className="shrink-0" aria-hidden />
      )}
      <span>
        {state === 'saving'
          ? '保存中…'
          : state === 'error'
            ? '保存失败，草稿已保留。'
            : '已保存（演示）'}
      </span>
    </div>
  );
}

function RowSpecimens() {
  const [enabled, setEnabled] = useState(false);
  const [name, setName] = useState('示例名称');
  const [shell, setShell] = useState('posix');
  return (
    <Specimen
      id="rows"
      title="01 / SettingRow"
      source="Settings/Common/SettingRow + Common/Toggle, TextInput, CommandBlock"
      description="只比较单条设置的排列，不模拟整张设置页。"
    >
      <Caption>inline · 短控件</Caption>
      <SettingSection>
        <SettingRow
          title="开关设置"
          description="说明文字保持稳定。"
          className="settings-demo-row"
        >
          <Toggle checked={enabled} onChange={setEnabled} label="开关设置" />
        </SettingRow>
        <SettingRow
          title="文本设置"
          description="输入区域有标准宽度，右侧与其他控件对齐。"
          labelFor="specimen-name"
          className="settings-demo-row"
        >
          <SettingControl className="settings-control-standard">
            <TextInput
              size="field"
              id="specimen-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full"
            />
          </SettingControl>
        </SettingRow>
      </SettingSection>
      <Caption>stacked · 连接指引（现有使用场景）</Caption>
      <SettingSection>
        <SettingRow
          title="连接运行 Agent 的机器"
          description="命令、目标 Shell 和操作需要全宽空间，不是普通表单字段。"
          layout="stacked"
          className="settings-demo-row settings-demo-row-stacked"
        >
          <div className="space-y-3">
            <CommandBlock
              text={
                shell === 'posix'
                  ? 'pnpm start:daemon'
                  : 'pnpm.cmd start:daemon'
              }
            />
            <div className="flex flex-wrap items-center gap-2">
              <Select
                className="settings-select"
                appearance="field"
                ariaLabel="连接指引目标 Shell"
                value={shell}
                onChange={setShell}
                options={[
                  { value: 'posix', label: 'macOS / Linux' },
                  { value: 'powershell', label: 'PowerShell' },
                ]}
              />
              <Button
                variant="outline"
                size="field"
                onClick={() =>
                  toast('这里只展示命令操作的布局，没有复制或连接机器。', {
                    tone: 'neutral',
                  })
                }
              >
                <Copy />
                复制（演示）
              </Button>
            </div>
          </div>
        </SettingRow>
      </SettingSection>
    </Specimen>
  );
}

function SectionSpecimens() {
  const [enabled, setEnabled] = useState(false);
  return (
    <Specimen
      id="sections"
      title="02 / SettingSection + SettingSubGroup"
      source="Settings/Common/SettingSection, SettingSubGroup, SettingLabel"
      description="分区、折叠和依赖层级分别展示。"
    >
      <SettingSection title="普通分区">
        <SettingRow
          title={<SettingLabel optional>可选设置</SettingLabel>}
          description="可选标记附属于标题，不增加额外卡片。"
          className="settings-demo-row"
        >
          <span className="text-fg-muted text-xs">默认值</span>
        </SettingRow>
      </SettingSection>
      <SettingSection title="可折叠分区" collapsible defaultCollapsed>
        <SettingRow title="折叠内容" className="settings-demo-row">
          <span className="text-fg-muted text-xs">展开后可见</span>
        </SettingRow>
      </SettingSection>
      <SettingSection title="依赖子分组">
        <SettingRow
          title="启用高级选项"
          description="子设置展开后保留轻量层级。"
          className="settings-demo-row"
        >
          <Toggle
            checked={enabled}
            onChange={setEnabled}
            label="启用高级选项"
          />
        </SettingRow>
        {enabled && (
          <SettingSubGroup>
            <SettingRow
              title="子设置"
              className="settings-demo-row settings-demo-row-compact"
            >
              <span className="text-fg-muted text-xs">属于上面的开关</span>
            </SettingRow>
          </SettingSubGroup>
        )}
      </SettingSection>
    </Specimen>
  );
}

function ControlSpecimens() {
  const [model, setModel] = useState('inherit');
  const [count, setCount] = useState('3');
  const [language, setLanguage] = useState('zh');
  const [endpoint, setEndpoint] = useState('https://example.com');
  const invalidCount =
    !Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 20;
  return (
    <Specimen
      id="controls"
      title="03 / SettingControl · 基础控件"
      source="Settings/Common/SettingControl + Common/Select, TextInput, Input"
      description="自然宽度、紧凑选择器、标准输入列与数值单位共用右侧对齐线。"
    >
      <Caption>控件宽度按用途变化，不把开关和短选项拉满</Caption>
      <SettingSection>
        <SettingRow
          title="语言"
          description="紧凑宽度 · 短枚举选项"
          className="settings-demo-row"
        >
          <SettingControl className="settings-control-compact">
            <Select
              className="settings-select"
              appearance="field"
              ariaLabel="示例语言"
              value={language}
              onChange={setLanguage}
              options={[
                { value: 'zh', label: '简体中文' },
                { value: 'en', label: 'English' },
              ]}
            />
          </SettingControl>
        </SettingRow>
        <SettingRow
          title="模型"
          description="标准输入列 · 长名称"
          className="settings-demo-row"
        >
          <SettingControl className="settings-control-standard">
            <Select
              className="settings-select"
              appearance="field"
              ariaLabel="示例模型"
              value={model}
              onChange={setModel}
              options={[
                { value: 'inherit', label: '继承默认' },
                { value: 'fast', label: '示例模型 · 快速' },
                { value: 'unavailable', label: '不可用选项', disabled: true },
              ]}
            />
          </SettingControl>
        </SettingRow>
        <SettingRow
          title="Endpoint"
          description="标准输入列 · URL"
          labelFor="specimen-endpoint"
          className="settings-demo-row"
        >
          <SettingControl className="settings-control-standard">
            <TextInput
              size="field"
              id="specimen-endpoint"
              type="url"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              className="w-full"
            />
          </SettingControl>
        </SettingRow>
        <SettingRow
          title="数量"
          description="自然宽度 · 数字与单位"
          className="settings-demo-row"
        >
          <div className="settings-number-control">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={20}
                aria-label="示例数量"
                aria-invalid={invalidCount}
                aria-describedby="specimen-count-feedback"
                value={count}
                onChange={(event) => setCount(event.target.value)}
                className={textInputClassName({
                  size: 'field',
                  className: 'w-20',
                })}
              />
              <span className="text-fg-muted text-xs">轮（1–20）</span>
            </div>
            <div id="specimen-count-feedback">
              {invalidCount && (
                <p role="alert" className="text-danger-fg mt-1 text-xs">
                  请输入 1–20 之间的整数。
                </p>
              )}
            </div>
          </div>
        </SettingRow>
      </SettingSection>
      <Caption>只读文本 · 与可编辑输入区分</Caption>
      <p className="text-fg-muted font-mono text-xs break-all">
        /Users/example/project
      </p>
    </Specimen>
  );
}

function SecretSpecimens() {
  const [saved, setSaved] = useState(false);
  return (
    <Specimen
      id="secrets"
      title="04 / ApiKeyRow"
      source="Settings/Common/ApiKeyRow（内部复用 TextInput + Button）"
      description="点击设置 / 更新，直接查看当前组件的输入、保存、取消形态。仅保存“是否配置”的演示状态。"
    >
      <SettingSection>
        <div className="settings-secret-specimen">
          <ApiKeyRow
            title="凭据"
            ariaLabel="演示凭据"
            saved={saved}
            placeholder="仅输入演示值"
            onSave={() => setSaved(true)}
            onRemove={() => setSaved(false)}
          />
        </div>
      </SettingSection>
      <Caption>只读变体 · 状态标签与操作紧凑右对齐（组合草稿）</Caption>
      <SettingSection>
        <SettingRow
          title="只读凭据"
          description="凭据已保存，不代表验证有效。"
          className="settings-demo-row"
        >
          <div className="settings-credential-actions">
            <span className="settings-credential-badge">
              <Check size={12} aria-hidden />
              已配置
            </span>
            <Button
              variant="outline"
              size="field"
              disabled
              aria-label="更新凭据（只读示例）"
            >
              更新凭据
            </Button>
          </div>
        </SettingRow>
      </SettingSection>
      <p className="text-fg-subtle mt-3 text-xs">
        这是现有行为展示。异步失败保留编辑器属于待改契约，本页不伪装成已实现。
      </p>
    </Specimen>
  );
}

function PlacementSpecimens() {
  const [state, setState] = useState<FeedbackState>('error');
  const [value, setValue] = useState('demo');
  return (
    <Specimen
      id="feedback"
      title="05 / SettingStatus · 反馈槽位"
      source="草稿：SettingRow + Common/TextInput, Loading, Button"
      description="统一的是反馈位置。静态说明、长期状态和操作反馈不互相替换。"
      draft
    >
      <TabGroup
        size="sm"
        value={state}
        onChange={setState}
        options={[
          { value: 'idle', label: '无反馈' },
          { value: 'saving', label: '保存中' },
          { value: 'saved', label: '已保存' },
          { value: 'error', label: '失败' },
        ]}
        className="mb-4 flex-wrap"
      />
      <Caption>字段 / 行级 · 反馈在控件下方</Caption>
      <SettingSection>
        <SettingRow
          title="字段示例"
          description="这一行说明不随状态变化。"
          labelFor="feedback-input"
          className="settings-demo-row settings-demo-row-feedback"
        >
          <SettingControl className="settings-control-standard">
            <TextInput
              size="field"
              id="feedback-input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={state === 'error'}
              aria-describedby="field-feedback"
              className="w-full"
            />
            <div id="field-feedback" className="mt-1.5">
              <Feedback state={state} />
            </div>
          </SettingControl>
        </SettingRow>
      </SettingSection>
      <Caption>整组 · 反馈和操作在同一区域</Caption>
      <div className="settings-feedback-actions border-edge-default bg-surface flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
        <Feedback state={state} />
        <Button
          size="field"
          disabled={state === 'saving'}
          onClick={() => setState('saved')}
        >
          重试（演示成功）
        </Button>
      </div>
    </Specimen>
  );
}

function ActionsSpecimens() {
  const [draft, setDraft] = useState('草稿内容');
  const [saved, setSaved] = useState('草稿内容');
  const [state, setState] = useState<FeedbackState>('idle');
  const [fail, setFail] = useState(true);
  return (
    <Specimen
      id="actions"
      title="06 / SettingActions · 操作组合"
      source="草稿：Common/Button + TextInput + 本地草稿状态"
      description="显式提交、失败保留草稿、取消恢复已保存值。没有真实请求。"
      draft
    >
      <div className="space-y-3">
        <TextInput
          size="field"
          aria-label="操作区草稿"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setState('idle');
          }}
          className="w-full"
        />
        <div className="flex items-center gap-2">
          <Toggle checked={fail} onChange={setFail} label="模拟保存失败" />
          <span className="text-fg-muted text-xs">模拟保存失败</span>
        </div>
        <div className="settings-feedback-actions border-edge-default flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <Feedback state={state} />
          <div className="ml-auto flex gap-2">
            <Button
              variant="outline"
              size="field"
              onClick={() => {
                setDraft(saved);
                setState('idle');
              }}
            >
              取消
            </Button>
            <Button
              size="field"
              disabled={draft === saved}
              onClick={() => {
                if (fail) setState('error');
                else {
                  setSaved(draft);
                  setState('saved');
                }
              }}
            >
              保存
            </Button>
          </div>
        </div>
        <Caption>危险操作 / 轻量确认 · 独立控件形态</Caption>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" tone="danger" size="field" disabled>
            删除（须确认）
          </Button>
          <Button
            variant="outline"
            size="field"
            onClick={() =>
              toast('轻量确认示例；没有实际复制内容。', { tone: 'neutral' })
            }
          >
            <Copy />
            Toast 示例
          </Button>
        </div>
      </div>
    </Specimen>
  );
}

function EntitySpecimens() {
  const [state, setState] = useState<'list' | 'loading' | 'empty'>('list');
  return (
    <Specimen
      id="entities"
      title="07 / SettingEntityList · 实体行"
      source="草稿：SettingRow + Common/Button, Loading, EmptyState"
      description="列表、加载和空态独立比较，不读取真实设备或 Profile。"
      draft
    >
      <TabGroup
        size="sm"
        value={state}
        onChange={setState}
        options={[
          { value: 'list', label: '列表' },
          { value: 'loading', label: '加载' },
          { value: 'empty', label: '空态' },
        ]}
        className="mb-4 flex-wrap"
      />
      {state === 'loading' ? (
        <Loading layout="inline" message="加载示例列表…" />
      ) : state === 'empty' ? (
        <EmptyState message="还没有可用 Agent" className="py-8" />
      ) : (
        <SettingSection>
          <SettingRow
            className="settings-demo-row"
            title="示例 Agent A"
            description="本机 · 设备已连接"
            leading={
              <span className="bg-bg-default text-fg-muted rounded p-1 text-xs">
                A
              </span>
            }
          >
            <span className="text-success-fg text-xs">已连接</span>
          </SettingRow>
          <SettingRow
            className="settings-demo-row"
            title="示例 Agent B"
            description="远程机器 · 不代表已登录"
          >
            <span className="text-warning-fg text-xs">离线</span>
          </SettingRow>
        </SettingSection>
      )}
    </Specimen>
  );
}

function GlobalSpecimens() {
  return (
    <Specimen
      id="global"
      title="08 / Banner · 全局反馈"
      source="草稿：现有语义 token + Common/Button"
      description="只承载页面级阻断；局部字段错误不升级成全局警告。"
      draft
    >
      <div
        className="border-warning bg-warning-bg rounded-md border p-3"
        role="status"
      >
        <p className="text-fg-default flex items-center gap-2 text-xs font-medium">
          <AlertTriangle size={14} className="text-warning-fg" aria-hidden />
          当前配置只读
        </p>
        <p className="text-fg-muted mt-1 text-xs">
          可以查看设置；恢复写入后才能修改。
        </p>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span className="text-success-fg text-xs">已配置</span>
        <span className="text-warning-fg text-xs">离线</span>
        <span className="text-fg-muted text-xs">不支持</span>
      </div>
      <p className="text-fg-subtle mt-2 text-xs">
        长期事实保持可见，不随“保存成功”提示消失。
      </p>
    </Specimen>
  );
}

export default function SettingsComponentsPlaygroundPage() {
  const [revision, setRevision] = useState(0);
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const element = document.documentElement;
    const previous = element.classList.contains('dark');
    element.classList.toggle('dark', dark);
    return () => {
      element.classList.toggle('dark', previous);
    };
  }, [dark]);
  return (
    <main className="settings-components-playground h-full overflow-y-auto">
      <div className="bg-bg-default text-fg-default min-h-full p-4 sm:p-8">
        <div className="mx-auto max-w-6xl">
          <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-fg-subtle mb-1 text-xs">
                PLAYGROUND / COMPONENT SPECIMENS
              </p>
              <h1 className="text-xl font-semibold">Settings 组件展厅</h1>
              <p className="text-fg-muted mt-2 max-w-2xl text-sm">
                已落地的 Settings 组件：轻边框分组、统一字号与留白、字段型
                Select。直接复用正式组件；反馈、操作区与列表组合仍为本地草稿。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="field"
                onClick={() => setDark(!dark)}
                aria-pressed={dark}
              >
                {dark ? '浅色' : '深色'}预览
              </Button>
              <Button
                variant="outline"
                size="field"
                onClick={() => setRevision(revision + 1)}
              >
                <RotateCcw />
                重置示例
              </Button>
              <Link
                to="/playground/components"
                className="text-info-fg self-center px-2 text-xs underline"
              >
                Common 展厅
              </Link>
            </div>
          </header>
          <div className="border-edge-default bg-surface mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3">
            <span className="text-fg-default text-[13px] font-medium">
              正式组件样式
            </span>
            <p className="text-fg-subtle text-xs">
              已落地：主文字 13px / 说明 12px / 内边距上下 12px、左右 14px /
              标题说明间距 2px / 控件高度 32px / 控件圆角 6px / Select
              上下双箭头
            </p>
          </div>
          <div className="settings-specimen-grid" key={revision}>
            <RowSpecimens />
            <SectionSpecimens />
            <ControlSpecimens />
            <SecretSpecimens />
            <PlacementSpecimens />
            <ActionsSpecimens />
            <EntitySpecimens />
            <GlobalSpecimens />
          </div>
        </div>
      </div>
    </main>
  );
}
