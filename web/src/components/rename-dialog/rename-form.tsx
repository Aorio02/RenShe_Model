'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { TagRenameId } from '@/constants/knowledge';
import { IModalProps } from '@/interfaces/common';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

export function RenameForm({
  initialName,
  hideModal,
  onOk,
  initialIdCard,
}: IModalProps<any> & {
  initialName?: string;
  initialIdCard?: string;
}) {
  const { t } = useTranslation();

  const FormSchema = z.object({
    name: z
      .string()
      .min(1, {
        message: t('common.namePlaceholder'),
      })
      .trim(),
    idCardNumber: z.string()
      .regex(/^\d{17}[\dXx]$/, {
        message: t('common.idCardFormatError') || '身份证号格式不正确',
      })
      .trim(),
  });

  const form = useForm<z.infer<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      name: '',
      idCardNumber: ''
    },
  });

  async function onSubmit(data: z.infer<typeof FormSchema>) {
    const ret = await onOk?.(data);
    if (ret) {
      hideModal?.();
    }
  }

  useEffect(() => {
    if (initialName) {
      form.setValue('name', initialName);
    }
    if (initialIdCard) {
      form.setValue('idCardNumber', initialIdCard);
    }
  }, [form, initialName, initialIdCard]);

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-6"
        id={TagRenameId}
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('common.name')}</FormLabel>
              <FormControl>
                <Input
                  placeholder={t('common.namePlaceholder')}
                  {...field}
                  autoComplete="off"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* 身份证号输入框 */}
        <FormField
          control={form.control}
          name="idCardNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('chat.idCardNumber') || '身份证号'}</FormLabel>
              <FormControl>
                <Input
                  placeholder={t('common.idCardPlaceholder') || '请输入身份证号'}
                  {...field}
                  autoComplete="off"
                  maxLength={18}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </form>
    </Form>
  );
}