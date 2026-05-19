export const LANGUAGES_CONFIG = {
  en: {
    name: 'English',
    nameEn: 'English',
    test: (code: string) => /^en/.test(code),
  },
  'zh-Hans': {
    name: '简体中文',
    nameEn: 'Simplified Chinese',
    test: (code: string) => /^zh/.test(code),
  },
  es: {
    name: 'Español',
    nameEn: 'Spanish',
    test: (code: string) => /^es/.test(code),
  },
  hi: {
    name: 'हिन्दी',
    nameEn: 'Hindi',
    test: (code: string) => /^hi/.test(code),
  },
  fr: {
    name: 'Français',
    nameEn: 'French',
    test: (code: string) => /^fr/.test(code),
  },
  ar: {
    name: 'العربية',
    nameEn: 'Arabic',
    test: (code: string) => /^ar/.test(code),
  },
  bn: {
    name: 'বাংলা',
    nameEn: 'Bengali',
    test: (code: string) => /^bn/.test(code),
  },
  'pt-BR': {
    name: 'Português (Brasil)',
    nameEn: 'Portuguese',
    test: (code: string) => /^pt/.test(code),
  },
  ru: {
    name: 'Русский',
    nameEn: 'Russian',
    test: (code: string) => /^ru/.test(code),
  },
  ur: {
    name: 'اردو',
    nameEn: 'Urdu',
    test: (code: string) => /^ur/.test(code),
  },
  id: {
    name: 'Bahasa Indonesia',
    nameEn: 'Indonesian',
    test: (code: string) => /^id/.test(code),
  },
  ja: {
    name: '日本語',
    nameEn: 'Japanese',
    test: (code: string) => /^ja/.test(code),
  },
};

/**
 * Detect the browser language.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc4646
 * @returns The detected language code.
 */
export function detectBrowserLanguage() {
  const language = window.navigator.language || 'en';

  for (const [langTag, langConf] of Object.entries(LANGUAGES_CONFIG)) {
    if (langConf.test(language)) {
      return langTag;
    }
  }

  return language;
}
