import { ComponentChildren } from 'preact';
import { IconBrandTwitterFilled, IconX } from '@tabler/icons-preact';

import { ErrorBoundary } from '@/components/error-boundary';
import { cx } from '@/utils/common';

import { Settings } from './settings';

type ControlPanelShellProps = {
  currentTheme: string;
  show: boolean;
  title: string;
  byline?: string;
  description: string;
  hookLine: string;
  healthLine: string;
  onToggle: () => void;
  children: ComponentChildren;
};

export function ControlPanelShell({
  currentTheme,
  show,
  title,
  byline,
  description,
  hookLine,
  healthLine,
  onToggle,
  children,
}: ControlPanelShellProps) {
  return (
    <section
      data-theme={currentTheme}
      class={cx(
        'card card-compact bg-base-100 fixed border shadow-xl w-80 leading-loose text-base-content py-3 rounded-box border-solid border-neutral-content border-opacity-50 left-8 top-8 transition-transform duration-500 flex flex-col overflow-hidden',
        show ? 'translate-x-0 transform-none' : 'translate-x-[-500px]',
      )}
      style={{ maxHeight: 'calc(100vh - 4rem)' }}
    >
      <header class="mx-4 mb-1 flex h-9 items-center">
        <IconBrandTwitterFilled class="mr-2 shrink-0 text-base-content" />
        <div class="flex-grow leading-none">
          <h2 class="font-semibold leading-none text-xl m-0">{title}</h2>
          {byline ? <p class="font-mono text-[10px] opacity-70 m-0 mt-1">{byline}</p> : null}
        </div>
        <ErrorBoundary>
          <Settings />
        </ErrorBoundary>
        <div
          onClick={onToggle}
          class="w-9 h-9 cursor-pointer flex justify-center items-center transition-colors duration-200 rounded-full hover:bg-base-200"
        >
          <IconX />
        </div>
      </header>
      <p class="mx-4 mb-1 text-sm leading-none text-base-content text-opacity-70">{description}</p>
      <p class="mx-4 mb-1 font-mono text-xs leading-none text-base-content text-opacity-60">
        {hookLine}
      </p>
      <p class="mx-4 mb-1 font-mono text-xs leading-none text-base-content text-opacity-60">
        {healthLine}
      </p>
      <div class="divider mt-0 mb-0"></div>
      <main class="min-h-0 grow overflow-y-auto overscroll-contain scroll-smooth">
        <div class="pl-4 pr-2">{children}</div>
      </main>
    </section>
  );
}
