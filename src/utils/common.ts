import dayjs from 'dayjs';
import { useSignal } from '@preact/signals';
import { EntityURL } from '@/types';
import logger from './logger';

/**
 * JSON.parse with error handling.
 */
export function safeJSONParse(text: string) {
  try {
    return JSON.parse(text);
  } catch (e) {
    logger.error((e as Error).message);
    return null;
  }
}

/**
 * Use signal to mimic React's `useState` hook.
 */
export function useSignalState<T>(value: T) {
  const signal = useSignal(value);

  const updateSignal = (newValue: T) => {
    signal.value = newValue;
  };

  return [signal.value, updateSignal, signal] as const;
}

/**
 * A signal representing a boolean value.
 */
export function useToggle(defaultValue = false) {
  const signal = useSignal(defaultValue);

  const toggle = () => {
    signal.value = !signal.value;
  };

  return [signal.value, toggle, signal] as const;
}

/**
 * Merge CSS class names.
 * Avoid using `tailwind-merge` here since it increases bundle size.
 *
 * @example
 * cx('foo', 'bar', false && 'baz') // => 'foo bar'
 */
export function cx(...classNames: (string | boolean | undefined)[]) {
  return classNames.filter(Boolean).join(' ');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isEqual(obj1: any, obj2: any) {
  return JSON.stringify(obj1) === JSON.stringify(obj2);
}

export function capitalizeFirstLetter(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function xssFilter(str: string) {
  return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeHTML(str: string) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeSafeLinkURL(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Replace t.co URLs in a string with real HTML links.
 *
 * @example
 * ```jsx
 * // Input:
 * strEntitiesToHtml('Verification: https://t.co/hHSWmpjfbA NASA Hubble Space Telescope', [
 *   {
 *     "display_url": "nasa.gov/socialmedia",
 *     "expanded_url": "http://nasa.gov/socialmedia",
 *     "url": "https://t.co/hHSWmpjfbA",
 *     "indices": [140, 163]
 *   }
 * ]);
 *
 * // Output:
 * <p>Verification: <a href="http://nasa.gov/socialmedia">nasa.gov/socialmedia</a> NASA Hubble Space Telescope</p>
 * ```
 */
export function strEntitiesToHTML(str: string, urls?: EntityURL[]) {
  if (!urls?.length) {
    return escapeHTML(str);
  }

  let cursor = 0;
  let html = '';

  const entities = [...urls]
    .filter((entity) => Array.isArray(entity.indices) && entity.indices.length >= 2)
    .map((entity) => ({
      ...entity,
      start: Math.max(0, Number(entity.indices[0]) || 0),
      end: Math.max(0, Number(entity.indices[1]) || 0),
    }))
    .filter((entity) => entity.end > entity.start && entity.start < str.length)
    .sort((a, b) => a.start - b.start);

  for (const entity of entities) {
    const start = Math.max(cursor, entity.start);
    const end = Math.min(str.length, entity.end);
    if (start > cursor) {
      html += escapeHTML(str.slice(cursor, start));
    }

    const originalText = str.slice(start, end);
    const href = normalizeSafeLinkURL(entity.expanded_url ?? entity.url);
    if (href) {
      html += `<a class="link" target="_blank" rel="noopener noreferrer" href="${escapeHTML(
        href,
      )}">${escapeHTML(entity.display_url ?? originalText)}</a>`;
    } else {
      html += escapeHTML(originalText);
    }
    cursor = end;
  }

  if (cursor < str.length) {
    html += escapeHTML(str.slice(cursor));
  }

  return html;
}

export function parseTwitterDateTime(str: string | undefined) {
  if (!str) {
    return dayjs(0);
  }

  // "Thu Sep 28 11:07:25 +0000 2023"
  // const regex = /^\w+ (\w+) (\d+) ([\d:]+) \+0000 (\d+)$/;
  const trimmed = str.replace(/^\w+ (.*)$/, '$1');
  return dayjs(trimmed, 'MMM DD HH:mm:ss ZZ YYYY', 'en');
}

export function formatDateTime(date: string | number | dayjs.Dayjs, format?: string) {
  if (typeof date === 'number' || typeof date === 'string') {
    date = dayjs(date);
  }

  // Display in local time zone.
  return date.format(format);
}

export function formatTwitterBirthdate(arg?: { day: number; month: number; year?: number }) {
  if (!arg) {
    return null;
  }

  const { day, month, year } = arg;
  const date = dayjs()
    .set('year', year ?? 0)
    .set('month', month - 1)
    .set('date', day);

  return year ? date.format('MMM DD, YYYY') : date.format('MMM DD');
}

export function formatVideoDuration(durationInMs?: number): string {
  if (typeof durationInMs !== 'number' || Number.isNaN(durationInMs)) {
    return 'N/A';
  }

  const durationInSeconds = Math.floor(durationInMs / 1000);
  const minutes = Math.floor(durationInSeconds / 60);
  const seconds = durationInSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
