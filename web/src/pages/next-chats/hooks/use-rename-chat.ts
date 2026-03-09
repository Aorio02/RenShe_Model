import { useSetModalState } from '@/hooks/common-hooks';
import { useSetDialog } from '@/hooks/use-chat-request';
import { useFetchTenantInfo } from '@/hooks/use-user-setting-request';
import { IDialog } from '@/interfaces/database/chat';
import { isEmpty, omit } from 'lodash';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

export const useRenameChat = () => {
  const [chat, setChat] = useState<IDialog>({} as IDialog);
  const {
    visible: chatRenameVisible,
    hideModal: hideChatRenameModal,
    showModal: showChatRenameModal,
  } = useSetModalState();
  const { setDialog, loading } = useSetDialog();
  const { t } = useTranslation();
  const tenantInfo = useFetchTenantInfo();

  const InitialData = useMemo(
    () => ({
      name: '',
      icon: '',
      language: 'English',
      description: '',
      prompt_config: {
        empty_response: '',
        prologue: t('chat.setAnOpenerInitial'),
        quote: true,
        keyword: false,
        tts: false,
        system: t('chat.systemInitialValue'),
        refine_multiturn: false,
        use_kg: true, // 强制启用知识库
        reasoning: false,
        parameters: [{ key: "knowledge", optional: false }],
        toc_enhance: false,
      },
      llm_id: tenantInfo.data.llm_id,
      llm_setting: {},
      similarity_threshold: 0.2,
      vector_similarity_weight: 0.3,
      top_n: 8,
      social_security_number: '',
      date_of_birth: '',
      kb_ids: ["e07c00281b6711f1a6bf93a9f5ab70b5"],
      // dataset_ids: ["e07c00281b6711f1a6bf93a9f5ab70b5"],
    }),
    [t, tenantInfo.data.llm_id],
  );

  const onChatRenameOk = useCallback(
  async (formData: { name: string; socialSecurityNumber?: string; date?: string }) => {
    const { name, socialSecurityNumber, date } = formData;

    const nextChat = {
      ...(isEmpty(chat)
        ? {
            ...InitialData,
            social_security_number: socialSecurityNumber || '',
            date_of_birth: date || '', // 注意这里对应表单的 date 字段
          }
        : {
            ...omit(chat, 'nickname', 'tenant_avatar', 'operator_permission'),
            dialog_id: chat.id,
            social_security_number: socialSecurityNumber || (chat as any).social_security_number || '',
            date_of_birth: date || (chat as any).date_of_birth || '',
          }),
      name, // 这里 name 就是字符串了
    };

    const ret = await setDialog(nextChat);

    if (ret === 0) {
      hideChatRenameModal();
    }
  },
  [chat, InitialData, setDialog, hideChatRenameModal],
);

  const handleShowChatRenameModal = useCallback(
    (record?: IDialog) => {
      if (record) {
        setChat(record);
      } else {
        setChat({} as IDialog);
      }
      showChatRenameModal();
    },
    [showChatRenameModal],
  );

  const handleHideModal = useCallback(() => {
    hideChatRenameModal();
    setChat({} as IDialog);
  }, [hideChatRenameModal]);

  return {
    chatRenameLoading: loading,
    initialChatName: chat?.name,
    onChatRenameOk,
    chatRenameVisible,
    hideChatRenameModal: handleHideModal,
    showChatRenameModal: handleShowChatRenameModal,
  };
};