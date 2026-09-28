// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Copy, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLink,
  DropdownMenuSubmenu,
} from '@/components/Common/DropdownMenu';
import { Select } from '@/components/Common/Select';
import { SplitSelect } from '@/components/Common/SplitSelect';

function MenuStylesFixture() {
  const [value, setValue] = useState('first');
  const [result, setResult] = useState('');
  const options = [
    {
      value: 'first',
      label: 'First option',
      icon: <Copy />,
      description: 'Option description',
    },
    {
      value: 'second',
      label: 'Second option',
      icon: <Copy />,
      shortcut: 'Ctrl+2',
      sectionLabel: 'New destination',
    },
    {
      value: 'long',
      label: 'LongUnbrokenLabel'.repeat(20),
      shortcut: 'Ctrl+3',
    },
  ];
  return (
    <div className="flex flex-col items-start gap-3 p-4">
      <output data-menu-result>{result}</output>
      <div className="w-64">
        <Select
          ariaLabel="Select sample"
          value={value}
          onChange={setValue}
          options={[
            ...options,
            { value: 'disabled', label: 'Disabled option', disabled: true },
          ]}
          footerSlot={<span>Footer</span>}
        />
      </div>
      <SplitSelect
        menuTitle="Split sample"
        size="lg"
        options={options}
        value={value}
        onChange={setValue}
        onPrimaryAction={setResult}
      />
      <DropdownMenu trigger={<Button>Menu sample</Button>}>
        <DropdownMenuItem
          icon={<Copy />}
          shortcut="Ctrl+2"
          onClick={() => setResult('action')}
        >
          Action
        </DropdownMenuItem>
        <DropdownMenuLink to="#destination" icon={<Copy />}>
          Link
        </DropdownMenuLink>
        <DropdownMenuItem disabled>Disabled action</DropdownMenuItem>
        <DropdownMenuItem
          icon={<Trash2 />}
          className="text-danger"
          onClick={() => setResult('delete')}
        >
          Delete
        </DropdownMenuItem>
        <DropdownMenuSubmenu label="Submenu">
          <DropdownMenuItem onClick={() => setResult('nested')}>
            Nested action
          </DropdownMenuItem>
        </DropdownMenuSubmenu>
      </DropdownMenu>
    </div>
  );
}

export function mountMenuStylesFixture() {
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;inset:0;background:var(--bg-default);z-index:9000;overflow:auto';
  document.body.append(host);
  createRoot(host).render(
    <MemoryRouter>
      <MenuStylesFixture />
    </MemoryRouter>,
  );
}
