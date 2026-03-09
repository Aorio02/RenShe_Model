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
  initialDate,
}: IModalProps<any> & { 
  initialName?: string;
  initialDate?: string;
}) {
  const { t } = useTranslation();

  const FormSchema = z.object({
    name: z
      .string()
      .min(1, {
        message: t('common.namePlaceholder'),
      })
      .trim(),
    date: z.string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, {
        message: t('common.dateFormatError'),
      })
      .trim(),
  });

  const form = useForm<z.infer<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
    defaultValues: { 
      name: '',
      date: ''
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
    if (initialDate) {
      form.setValue('date', initialDate);
    }
  }, [form, initialName, initialDate]);

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

        {/* 年月日输入框 */}
        <FormField
          control={form.control}
          name="date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('common.date')}</FormLabel>
              <FormControl>
                <Input
                  placeholder={t('common.datePlaceholder')}
                  {...field}
                  autoComplete="off"
                  type="date"
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