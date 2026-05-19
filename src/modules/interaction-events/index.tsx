import { Extension, ExtensionType } from '@/core/extensions';
import { InteractionEventsInterceptor } from './api';
import { InteractionEventsPanel } from './ui';

export default class InteractionEventsModule extends Extension {
  name = 'InteractionEventsModule';

  type = ExtensionType.CUSTOM;

  intercept() {
    return InteractionEventsInterceptor;
  }

  render() {
    return InteractionEventsPanel;
  }
}
