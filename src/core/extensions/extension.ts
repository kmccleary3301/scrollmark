import { ComponentType } from 'preact';
import type { ExtensionManager } from './manager';

export interface ExtensionConstructor {
  new (manager: ExtensionManager): Extension;
}

/**
 * Extension UI component type.
 */
export type ExtensionUIComponentType = ComponentType<{ extension: Extension }> | null;

/**
 * HTTP response interceptor.
 */
export interface InterceptorRequest extends Pick<Request, 'method' | 'url'> {
  body?: string;
  requestId?: string;
  bookmarkContext?: unknown;
  __twe_hook_revision_v1?: number;
  hookRevision?: number;
}

export type Interceptor = (
  request: InterceptorRequest,
  response: XMLHttpRequest,
  extension: Extension,
) => void;

/**
 * Wether the extension works on tweets or users.
 */
export enum ExtensionType {
  TWEET = 'tweet',
  USER = 'user',
  CUSTOM = 'custom',
  NONE = 'none',
}

/**
 * The base class for all extensions.
 */
export abstract class Extension {
  public name: string = '';
  public enabled = true;
  public type: ExtensionType = ExtensionType.NONE;

  protected manager: ExtensionManager;

  constructor(manager: ExtensionManager) {
    this.manager = manager;
  }

  /**
   * Optionally run side effects when enabled.
   */
  public setup(): void {
    // noop
  }

  /**
   * Optionally clear side effects when disabled.
   */
  public dispose(): void {
    // noop
  }

  /**
   * Intercept HTTP responses.
   */
  public intercept(): Interceptor | null {
    return null;
  }

  /**
   * Render extension UI.
   */
  public render(): ExtensionUIComponentType {
    return null;
  }
}
