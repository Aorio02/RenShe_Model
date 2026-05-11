import { NextMessageInput } from '@/components/message-input/next';
import MessageItem from '@/components/message-item';
import PdfSheet from '@/components/pdf-drawer';
import { useClickDrawer } from '@/components/pdf-drawer/hooks';
import { MessageType } from '@/constants/chat';
import {
  useFetchDialog,
  useGetChatSearchParams,
} from '@/hooks/use-chat-request';
import { useFetchUserInfo } from '@/hooks/use-user-setting-request';
import { IClientConversation } from '@/interfaces/database/chat';
import { buildMessageUuidWithRole } from '@/utils/chat';
import { useEffect, useRef, type MutableRefObject } from 'react';
import {
  useGetSendButtonDisabled,
  useSendButtonDisabled,
} from '../../hooks/use-button-disabled';
import { useCreateConversationBeforeUploadDocument } from '../../hooks/use-create-conversation';
import { useSendMessage } from '../../hooks/use-send-chat-message';
import { buildMessageItemReference } from '../../utils';

const mergeVoiceMeta = (previousVoice: any, incomingVoice: any) => {
  if (!incomingVoice) {
    return previousVoice;
  }

  if (incomingVoice.kind === 'segments') {
    const previousSegments =
      previousVoice?.kind === 'segments' ? previousVoice.segments ?? [] : [];

    return {
      ...(previousVoice?.kind === 'segments' ? previousVoice : {}),
      ...incomingVoice,
      kind: 'segments' as const,
      file_id: undefined,
      local_url: undefined,
      segments: (incomingVoice.segments ?? []).map((segment: any) => {
        const previousSegment = previousSegments.find(
          (item: any) => item.seq === segment.seq,
        );
        return {
          ...segment,
          object_url: segment.file_id
            ? undefined
            : segment.object_url ?? previousSegment?.object_url,
        };
      }),
    };
  }

  return {
    ...(previousVoice ?? {}),
    ...incomingVoice,
    kind: 'single' as const,
    segments: undefined,
    local_url: incomingVoice.local_url ?? previousVoice?.local_url,
  };
};

const mergeMessagesWithLocalVoice = (
  previous: IClientConversation['message'],
  incoming: IClientConversation['message'],
) => {
  const previousMap = new Map(
    previous.map((message) => [`${message.role}:${message.id}`, message]),
  );

  const nextMessages = incoming.map((message) => {
    const previousMessage = previousMap.get(`${message.role}:${message.id}`);
    if (!previousMessage) {
      return message;
    }

    return {
      ...previousMessage,
      ...message,
      voice: mergeVoiceMeta(previousMessage.voice, message.voice),
    };
  });

  const nextKeys = new Set(
    nextMessages.map((message) => `${message.role}:${message.id}`),
  );

  previous.forEach((message) => {
    const key = `${message.role}:${message.id}`;
    if (!nextKeys.has(key)) {
      nextMessages.push(message);
    }
  });

  return nextMessages;
};

interface IProps {
  controllerRef: MutableRefObject<AbortController>;
  stopOutputMessage(): void;
  conversation: IClientConversation;
}

export function SingleChatBox({
  controllerRef,
  stopOutputMessage,
  conversation,
}: IProps) {
  const {
    assistantVoiceAutoPlayNonceMap,
    consumeAssistantVoiceAutoPlay,
    value,
    scrollRef,
    messageContainerRef,
    sendLoading,
    loadingAssistantId,
    derivedMessages,
    isUploading,
    handleInputChange,
    handlePressEnter,
    handleVoiceSubmit,
    handleGenerateTable,
    regenerateMessage,
    removeMessageById,
    retryVoiceMessage,
    handleUploadFile,
    removeFile,
    setDerivedMessages,
  } = useSendMessage(controllerRef);
  const { data: userInfo } = useFetchUserInfo();
  const { data: currentDialog } = useFetchDialog();
  const { createConversationBeforeUploadDocument } =
    useCreateConversationBeforeUploadDocument();
  const { conversationId } = useGetChatSearchParams();
  const disabled = useGetSendButtonDisabled();
  const sendDisabled = useSendButtonDisabled(value);
  const { visible, hideModal, documentId, selectedChunk, clickDocumentButton } =
    useClickDrawer();
  const hydratedConversationIdRef = useRef('');

  useEffect(() => {
    const serverConversationId = conversation?.id ?? '';
    const messages = conversation?.message;
    if (serverConversationId && Array.isArray(messages) && messages.length > 0) {
      setDerivedMessages((previous) => {
        const switchedConversation =
          hydratedConversationIdRef.current !== serverConversationId;
        const sameConversationMessages = previous.filter(
          (message) => message.conversationId === serverConversationId,
        );
        hydratedConversationIdRef.current = serverConversationId;

        if (switchedConversation || previous.length === 0) {
          return sameConversationMessages.length > 0
            ? mergeMessagesWithLocalVoice(sameConversationMessages, messages)
            : messages;
        }

        return mergeMessagesWithLocalVoice(previous, messages);
      });
    }
  }, [conversation?.id, conversation?.message, setDerivedMessages]);

  useEffect(() => {
    // Clear the message list after deleting the conversation.
    if (conversationId === '') {
      hydratedConversationIdRef.current = '';
      setDerivedMessages([]);
    }
  }, [conversationId, setDerivedMessages]);

  return (
    <section className="flex flex-col p-5 h-full">
      <div ref={messageContainerRef} className="flex-1 overflow-auto min-h-0">
        <div className="w-full pr-5">
          {derivedMessages?.map((message, i) => {
            return (
              <MessageItem
                loading={
                  message.role === MessageType.Assistant &&
                  sendLoading &&
                  message.id === loadingAssistantId
                }
                key={buildMessageUuidWithRole(message)}
                item={message}
                assistantVoiceAutoPlayNonce={
                  message.role === MessageType.Assistant
                    ? assistantVoiceAutoPlayNonceMap[message.id]
                    : undefined
                }
                onAssistantVoiceAutoPlayConsumed={consumeAssistantVoiceAutoPlay}
                conversationId={conversationId}
                nickname={userInfo.nickname}
                avatar={userInfo.avatar}
                avatarDialog={currentDialog.icon}
                reference={buildMessageItemReference(
                  {
                    message: derivedMessages,
                    reference: conversation.reference,
                  },
                  message,
                )}
                clickDocumentButton={clickDocumentButton}
                index={i}
                removeMessageById={removeMessageById}
                regenerateMessage={regenerateMessage}
                retryVoiceMessage={retryVoiceMessage}
                sendLoading={sendLoading}
              ></MessageItem>
            );
          })}
        </div>
        <div ref={scrollRef} />
      </div>
      <NextMessageInput
        disabled={disabled}
        sendDisabled={sendDisabled}
        sendLoading={sendLoading}
        showUploadIcon={false}
        showActionLabels
        value={value}
        onInputChange={handleInputChange}
        onPressEnter={handlePressEnter}
        onVoiceSubmit={handleVoiceSubmit}
        onGenerateTable={handleGenerateTable}
        conversationId={conversationId}
        createConversationBeforeUploadDocument={
          createConversationBeforeUploadDocument
        }
        stopOutputMessage={stopOutputMessage}
        onUpload={handleUploadFile}
        isUploading={isUploading}
        removeFile={removeFile}
      />
      {visible && (
        <PdfSheet
          visible={visible}
          hideModal={hideModal}
          documentId={documentId}
          chunk={selectedChunk}
        ></PdfSheet>
      )}
    </section>
  );
}
