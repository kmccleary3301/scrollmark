import { Extension, ExtensionType } from '@/core/extensions';
import { LocalSearchUI } from './ui';

export default class LocalSearchModule extends Extension {
  name = 'LocalSearchModule';

  type = ExtensionType.CUSTOM;

  render() {
    return LocalSearchUI;
  }
}
