import { signal } from '@preact/signals';
import { isDiagnosticCaptureEnabled } from './diagnostics';

export interface LogLine {
  type: 'info' | 'warn' | 'error';
  line: string;
  index: number;
}

export const logLinesSignal = signal<LogLine[]>([]);
const MAX_LOG_LINES_DEFAULT = 200;
const MAX_LOG_LINES_DIAGNOSTIC = 400;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogExtraArgs = any[];

const CONSOLE_INFO_STORAGE_KEY = 'twe_console_info_v1';
const CONSOLE_VERBOSE_STORAGE_KEY = 'twe_console_verbose_v1';

function isTruthy(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function shouldPrintInfoToConsole(): boolean {
  try {
    if (isTruthy(localStorage.getItem(CONSOLE_VERBOSE_STORAGE_KEY))) {
      return true;
    }
  } catch {
    // ignore
  }

  try {
    // Optional, lower-noise console status mode.
    if (isTruthy(localStorage.getItem(CONSOLE_INFO_STORAGE_KEY))) {
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

function shouldPrintDebugToConsole(): boolean {
  try {
    return isTruthy(localStorage.getItem(CONSOLE_VERBOSE_STORAGE_KEY));
  } catch {
    return false;
  }
}

function getMaxLogLines(): number {
  if (isDiagnosticCaptureEnabled() || shouldPrintDebugToConsole()) {
    return MAX_LOG_LINES_DIAGNOSTIC;
  }
  return MAX_LOG_LINES_DEFAULT;
}

/**
 * Global logger that writes logs to both screen and console.
 */
class Logger {
  private index = 0;
  private buffer: LogLine[] = [];
  private bufferTimer: number | null = null;

  public info(line: string, ...args: LogExtraArgs) {
    if (shouldPrintInfoToConsole()) {
      console.info('[twitter-web-exporter]', line, ...args);
    }
    this.writeBuffer({ type: 'info', line, index: this.index++ });
  }

  public warn(line: string, ...args: LogExtraArgs) {
    console.warn('[twitter-web-exporter]', line, ...args);
    this.writeBuffer({ type: 'warn', line, index: this.index++ });
  }

  public error(line: string, ...args: LogExtraArgs) {
    console.error('[twitter-web-exporter]', line, ...args);
    this.writeBuffer({ type: 'error', line, index: this.index++ });
  }

  public errorWithBanner(msg: string, err?: Error, ...args: LogExtraArgs) {
    this.error(
      `${msg} (Message: ${err?.message ?? 'none'})\n` +
        '  This may be a problem caused by Twitter updates.\n  Please file an issue on GitHub:\n' +
        '  https://github.com/kmccleary3301/scrollmark/issues',
      ...args,
    );
  }

  public debug(...args: LogExtraArgs) {
    if (shouldPrintDebugToConsole()) {
      console.debug('[twitter-web-exporter]', ...args);
    }
  }

  /**
   * Buffer log lines to reduce the number of signal and DOM updates.
   */
  private writeBuffer(log: LogLine) {
    this.buffer.push(log);

    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer);
    }

    this.bufferTimer = window.setTimeout(() => {
      this.bufferTimer = null;
      this.flushBuffer();
    }, 0);
  }

  /**
   * Flush buffered log lines and update the UI.
   */
  private flushBuffer() {
    const next = [...logLinesSignal.value, ...this.buffer];
    const limit = getMaxLogLines();
    logLinesSignal.value = next.length > limit ? next.slice(next.length - limit) : next;
    this.buffer = [];
  }
}

/**
 * Global logger singleton instance.
 */
const logger = new Logger();

export default logger;
