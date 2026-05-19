import { Extension, ExtensionType } from '@/core/extensions';
import { RawCaptureInterceptor } from './api';

export default class RawCaptureModule extends Extension {
  name = 'RawCaptureModule';

  type = ExtensionType.CUSTOM;

  intercept() {
    return RawCaptureInterceptor;
  }
}
