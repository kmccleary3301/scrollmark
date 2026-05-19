import { CommonModuleUI } from '@/components/module-ui';
import { Extension, ExtensionType } from '@/core/extensions';
import { QuotesInterceptor } from './api';

export default class QuotesModule extends Extension {
  name = 'QuotesModule';

  type = ExtensionType.TWEET;

  intercept() {
    return QuotesInterceptor;
  }

  render() {
    return CommonModuleUI;
  }
}
