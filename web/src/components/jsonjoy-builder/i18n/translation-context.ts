import { createContext } from 'react';
import { zh } from './locales/zh';
import type { Translation } from './translation-keys.ts';

export const TranslationContext = createContext<Translation>(zh);
