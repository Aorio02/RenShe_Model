'use client';

import { KnowledgeBaseFormField } from '@/components/knowledge-base-item';
import { SwitchFormField } from '@/components/switch-fom-field';
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { useTranslate } from '@/hooks/common-hooks';
import { useFormContext } from 'react-hook-form';

export default function ChatBasicSetting() {
  const { t } = useTranslate('chat');
  const form = useFormContext();

  return (
    <div className="space-y-8">
      {/* <FormField
        control={form.control}
        name={'icon'}
        render={({ field }) => (
          <div className="space-y-6">
            <FormItem className="w-full">
              <FormLabel>{t('assistantAvatar')}</FormLabel>
              <FormControl>
                <AvatarUpload {...field}></AvatarUpload>
              </FormControl>
              <FormMessage />
            </FormItem>
          </div>
        )}
      /> */}
      {/* <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel required>{t('assistantName')}</FormLabel>
            <FormControl>
              <Input {...field}></Input>
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      /> */}
      {/* <FormField
        control={form.control}
        name="description"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t('description')}</FormLabel>
            <FormControl>
              <Textarea {...field}></Textarea>
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      /> */}
      {/* <FormField
        control={form.control}
        name={'prompt_config.empty_response'}
        render={({ field }) => (
          <FormItem>
            <FormLabel tooltip={t('emptyResponseTip')}>
              {t('emptyResponse')}
            </FormLabel>
            <FormControl>
              <Textarea {...field}></Textarea>
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      /> */}
      <FormField
        control={form.control}
        name={'prompt_config.prologue'}
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              {t('setAnOpener')}
            </FormLabel>
            <FormControl>
              <Textarea {...field}></Textarea>
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <SwitchFormField
        name={'prompt_config.quote'}
        label={t('quote')}
        tooltip={t('quoteTip')}
      ></SwitchFormField>
      <SwitchFormField
        name={'prompt_config.tts'}
        label={t('tts')}
        tooltip={t('ttsTip')}
      ></SwitchFormField>
      <KnowledgeBaseFormField></KnowledgeBaseFormField>
    </div>
  );
}
