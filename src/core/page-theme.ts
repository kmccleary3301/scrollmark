import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';

const LIGHT_THEME = 'cupcake';
const DARK_THEME = 'dracula';

type PageThemeMode = 'light' | 'dark';

function parseRgb(value: string): [number, number, number] | null {
  const match = value.match(/rgba?\(([^)]+)\)/i);
  const channels = match?.[1];
  if (!channels) return null;
  const parts = channels
    .split(',')
    .slice(0, 3)
    .map((part) => Number.parseFloat(part.trim()));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const [red, green, blue] = parts;
  if (red === undefined || green === undefined || blue === undefined) return null;
  return [red, green, blue];
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const normalized = Math.max(0, Math.min(255, channel)) / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });
  if (r === undefined || g === undefined || b === undefined) return 0;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function readDomThemeHint(): PageThemeMode | null {
  const candidates = [document.documentElement, document.body].filter(Boolean);
  for (const node of candidates) {
    const text = [
      node.getAttribute('data-theme'),
      node.getAttribute('data-color-mode'),
      node.getAttribute('color-mode'),
      node.className,
      node.getAttribute('style'),
    ]
      .join(' ')
      .toLowerCase();
    if (/\b(dark|dim|night|lights-out|black)\b/.test(text)) return 'dark';
    if (/\b(light|default|white)\b/.test(text)) return 'light';
  }
  return null;
}

function readComputedPageTheme(): PageThemeMode | null {
  const colorScheme = getComputedStyle(document.documentElement).colorScheme.toLowerCase();
  if (colorScheme.includes('dark')) return 'dark';
  if (colorScheme.includes('light')) return 'light';

  const main = document.querySelector<HTMLElement>('main');
  const nodes = [document.body, main, document.documentElement].filter(
    (node): node is HTMLElement => Boolean(node),
  );
  for (const node of nodes) {
    const rgb = parseRgb(getComputedStyle(node).backgroundColor);
    if (!rgb) continue;
    return relativeLuminance(rgb) < 0.35 ? 'dark' : 'light';
  }
  return null;
}

function readSystemTheme(): PageThemeMode {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function detectPageTheme(): PageThemeMode {
  if (typeof document === 'undefined') return readSystemTheme();
  return readDomThemeHint() ?? readComputedPageTheme() ?? readSystemTheme();
}

export function resolveAppTheme(optionTheme: string | undefined): string {
  if (optionTheme && optionTheme !== 'system') return optionTheme;
  return detectPageTheme() === 'dark' ? DARK_THEME : LIGHT_THEME;
}

export function useResolvedAppTheme(optionTheme: string | undefined) {
  const resolvedTheme = useSignal(resolveAppTheme(optionTheme));

  useEffect(() => {
    const refresh = () => {
      resolvedTheme.value = resolveAppTheme(optionTheme);
    };
    refresh();

    if (optionTheme && optionTheme !== 'system') return;

    const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener?.('change', refresh);

    const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(refresh) : null;
    if (observer && typeof document !== 'undefined') {
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'color-mode'],
      });
      if (document.body) {
        observer.observe(document.body, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'color-mode'],
        });
      }
    }

    return () => {
      media?.removeEventListener?.('change', refresh);
      observer?.disconnect();
    };
  }, [optionTheme, resolvedTheme]);

  return resolvedTheme;
}
