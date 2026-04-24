import { useContext } from 'react';
import { zh } from '../i18n/locales/zh';
import { TranslationContext } from '../i18n/translation-context';

export function useTranslation() {
  const translation = useContext(TranslationContext);
  return translation ?? zh;
}

export function formatTranslation(
  template: string,
  values: Record<string, string | number>,
) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = values[key];
    return value !== undefined ? String(value) : `{${key}}`;
  });
}
