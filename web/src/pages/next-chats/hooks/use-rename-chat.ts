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
        tts: true,
        system: t('chat.systemInitialValue'),
        refine_multiturn: false,
        use_kg: true, 
        reasoning: false,
        parameters: [{ key: "knowledge", optional: false }],
        toc_enhance: false,
      },
      llm_id: tenantInfo.data.llm_id,
      llm_setting: {},
      similarity_threshold: 0.2,
      vector_similarity_weight: 0.3,
      top_n: 8,
      id_card_number: '',
      kb_ids: ["c0a1cb4c4d4011f1a10d396579261294"],
    }),
    [t, tenantInfo.data.llm_id],
  );

  const onChatRenameOk = useCallback(
    async (formData: { name: string; idCardNumber?: string }) => {
      const { name, idCardNumber } = formData;

      const nextChat = {
        ...(isEmpty(chat)
          ? {
              ...InitialData,
              id_card_number: idCardNumber || '',
            }
          : {
              ...omit(chat, 'nickname', 'tenant_avatar', 'operator_permission'),
              dialog_id: chat.id,
              id_card_number: idCardNumber || (chat as any).id_card_number || '',
            }),
        name,
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
