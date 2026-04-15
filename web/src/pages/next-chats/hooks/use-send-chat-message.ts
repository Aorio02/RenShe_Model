import { Authorization } from '@/constants/authorization';
import { MessageType } from '@/constants/chat';
import {
  useHandleMessageInputChange,
  useRegenerateMessage,
  useSelectDerivedMessages,
  useSendMessageWithSse,
} from '@/hooks/logic-hooks';
import {
  useFetchDialog,
  useGetChatSearchParams,
} from '@/hooks/use-chat-request';
import { IMessage } from '@/interfaces/database/chat';
import { RecordedVoicePayload } from '@/components/ui/audio-button';
import api from '@/utils/api';
import { buildMessageUuid, sanitizeMessagesForRequest } from '@/utils/chat';
import { getAuthorization } from '@/utils/authorization-util';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { trim } from 'lodash';
import { toast } from 'sonner';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import { useParams } from 'react-router';
import { v4 as uuid } from 'uuid';
import { useCreateConversationBeforeSendMessage } from './use-chat-url';
import { useFindPrologueFromDialogList } from './use-select-conversation-list';
import { useUploadFile } from './use-upload-file';

const sortVoiceSegments = (
  segments: NonNullable<IMessage['voice']>['segments'] = [],
) => {
  return [...segments].sort((a, b) => a.seq - b.seq);
};

const mergeVoiceMeta = (
  previousVoice: IMessage['voice'] | undefined,
  incomingVoice: IMessage['voice'] | undefined,
) => {
  if (!incomingVoice) {
    return undefined;
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
      segments: sortVoiceSegments(
        (incomingVoice.segments ?? []).map((segment) => {
          const previousSegment = previousSegments.find(
            (item) => item.seq === segment.seq,
          );

          return {
            ...segment,
            object_url: segment.file_id
              ? undefined
              : previousSegment?.object_url,
          };
        }),
      ),
    };
  }

  return {
    ...(previousVoice ?? {}),
    ...incomingVoice,
    kind: 'single' as const,
    segments: undefined,
    local_url: incomingVoice.file_id ? undefined : previousVoice?.local_url,
  };
};

const getVoiceFileExtension = (mimeType: string) => {
  const normalizedType = mimeType.split(';')[0];
  const extensionMap: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/flac': 'flac',
  };

  return extensionMap[normalizedType] || 'webm';
};

export const useSelectNextMessages = () => {
  const {
    scrollRef,
    messageContainerRef,
    setDerivedMessages,
    derivedMessages,
    addNewestAnswer,
    addNewestQuestion,
    removeLatestMessage,
    removeMessageById,
    removeMessagesAfterCurrentMessage,
  } = useSelectDerivedMessages();
  const { isNew, conversationId } = useGetChatSearchParams();
  const { id: dialogId } = useParams();
  const prologue = useFindPrologueFromDialogList();

  const addPrologue = useCallback(() => {
    if (dialogId !== '' && isNew === 'true') {
      const nextMessage = {
        role: MessageType.Assistant,
        content: prologue,
        id: uuid(),
        conversationId: conversationId,
      } as IMessage;

      setDerivedMessages([nextMessage]);
    }
  }, [conversationId, dialogId, isNew, prologue, setDerivedMessages]);

  useEffect(() => {
    addPrologue();
  }, [addPrologue]);

  return {
    scrollRef,
    messageContainerRef,
    derivedMessages,
    addNewestAnswer,
    addNewestQuestion,
    removeLatestMessage,
    removeMessageById,
    removeMessagesAfterCurrentMessage,
    setDerivedMessages,
  };
};

export const useSendMessage = (
  controllerRef: MutableRefObject<AbortController>,
) => {
  const { conversationId, isNew } = useGetChatSearchParams();
  const { data: currentDialog } = useFetchDialog();
  const { handleInputChange, value, setValue } = useHandleMessageInputChange();
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [loadingAssistantId, setLoadingAssistantId] = useState('');
  const [assistantVoiceAutoPlayNonceMap, setAssistantVoiceAutoPlayNonceMap] =
    useState<Record<string, number>>({});
  const autoPlayEligibleAssistantIdsRef = useRef<Set<string>>(new Set());
  const previousConversationIdRef = useRef(conversationId);
  const assistantVoiceAutoPlayIssuedRef = useRef<Set<string>>(new Set());
  const assistantVoiceAutoPlayCounterRef = useRef(0);
  const assistantVoiceWaitControllersRef = useRef<
    Map<string, AbortController>
  >(new Map());

  const { handleUploadFile, isUploading, removeFile, files, clearFiles } =
    useUploadFile();

  const { send, answer, done } = useSendMessageWithSse(
    api.completeConversation,
  );
  const {
    scrollRef,
    messageContainerRef,
    derivedMessages,
    addNewestAnswer,
    addNewestQuestion,
    removeLatestMessage,
    removeMessageById,
    removeMessagesAfterCurrentMessage,
    setDerivedMessages,
  } = useSelectNextMessages();

  const assistantVoicePlaceholder = useMemo(
    () =>
      currentDialog?.prompt_config?.tts
        ? {
            kind: 'single' as const,
            status: 'streaming' as const,
            mime_type: 'audio/mpeg',
          }
        : undefined,
    [currentDialog?.prompt_config?.tts],
  );

  const markAssistantVoiceAutoPlay = useCallback((messageId?: string) => {
    if (
      !messageId ||
      assistantVoiceAutoPlayIssuedRef.current.has(messageId)
    ) {
      return;
    }

    assistantVoiceAutoPlayIssuedRef.current.add(messageId);
    assistantVoiceAutoPlayCounterRef.current += 1;

    setAssistantVoiceAutoPlayNonceMap((prev) => ({
      ...prev,
      [messageId]: assistantVoiceAutoPlayCounterRef.current,
    }));
  }, []);

  const consumeAssistantVoiceAutoPlay = useCallback(
    (messageId: string, nonce?: number) => {
      if (!messageId || !nonce) {
        return;
      }

      setAssistantVoiceAutoPlayNonceMap((prev) => {
        if (prev[messageId] !== nonce) {
          return prev;
        }

        const next = { ...prev };
        delete next[messageId];
        return next;
      });
    },
    [],
  );

  const { createConversationBeforeSendMessage } =
    useCreateConversationBeforeSendMessage();

  const upsertMessage = useCallback(
    (
      messageId: string,
      role: MessageType | undefined,
      updater: (message: IMessage | undefined) => IMessage,
    ) => {
      setDerivedMessages((prev) => {
        const index = prev.findIndex(
          (item) => item.id === messageId && (!role || item.role === role),
        );
        if (index === -1) {
          return [...prev, updater(undefined)];
        }
        return prev.map((item, idx) =>
          idx === index ? updater(item) : item,
        );
      });
    },
    [setDerivedMessages],
  );

  const appendMessageIfMissing = useCallback(
    (message: IMessage) => {
      setDerivedMessages((prev) => {
        if (prev.some((item) => item.id === message.id && item.role === message.role)) {
          return prev;
        }
        return [...prev, message];
      });
    },
    [setDerivedMessages],
  );

  const addAutoPlayEligibleAssistant = useCallback((messageId?: string) => {
    if (!messageId) {
      return;
    }
    autoPlayEligibleAssistantIdsRef.current.add(messageId);
    assistantVoiceAutoPlayIssuedRef.current.delete(messageId);
  }, []);

  const removeAutoPlayEligibleAssistant = useCallback((messageId?: string) => {
    if (!messageId) {
      return;
    }
    autoPlayEligibleAssistantIdsRef.current.delete(messageId);
  }, []);

  const abortAssistantVoiceWait = useCallback((messageId?: string) => {
    if (messageId) {
      assistantVoiceWaitControllersRef.current.get(messageId)?.abort();
      assistantVoiceWaitControllersRef.current.delete(messageId);
      return;
    }

    assistantVoiceWaitControllersRef.current.forEach((controller) => {
      controller.abort();
    });
    assistantVoiceWaitControllersRef.current.clear();
  }, []);

  const waitForAssistantVoice = useCallback(
    async ({
      targetConversationId,
      messageId,
    }: {
      targetConversationId: string;
      messageId: string;
    }) => {
      if (
        !targetConversationId ||
        !messageId ||
        assistantVoiceWaitControllersRef.current.has(messageId)
      ) {
        return;
      }

      const controller = new AbortController();
      assistantVoiceWaitControllersRef.current.set(messageId, controller);

      try {
        const response = await fetch(
          api.waitAssistantVoice({
            conversationId: targetConversationId,
            messageId,
            timeout: 120,
          }),
          {
            headers: {
              Authorization: getAuthorization(),
            },
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          throw new Error(`wait assistant voice failed: ${response.status}`);
        }

        const payload = await response.json();
        const message = payload?.data?.message as IMessage | undefined;
        if (!message?.id) {
          return;
        }

        const nextMessage = {
          ...message,
          role: MessageType.Assistant,
          conversationId: targetConversationId,
        } as IMessage;

        upsertMessage(nextMessage.id, MessageType.Assistant, (previous) => ({
          ...(previous ?? nextMessage),
          ...nextMessage,
          voice: mergeVoiceMeta(previous?.voice, nextMessage.voice),
          reference: nextMessage.reference ?? previous?.reference,
        }));

        if (
          autoPlayEligibleAssistantIdsRef.current.has(nextMessage.id) &&
          nextMessage.voice?.kind === 'single' &&
          nextMessage.voice.status === 'ready' &&
          nextMessage.voice.file_id
        ) {
          removeAutoPlayEligibleAssistant(nextMessage.id);
          markAssistantVoiceAutoPlay(nextMessage.id);
          return;
        }

        if (nextMessage.voice?.status !== 'streaming') {
          removeAutoPlayEligibleAssistant(nextMessage.id);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.warn('wait assistant voice failed', error);
      } finally {
        assistantVoiceWaitControllersRef.current.delete(messageId);
      }
    },
    [
      markAssistantVoiceAutoPlay,
      removeAutoPlayEligibleAssistant,
      upsertMessage,
    ],
  );

  const sendMessage = useCallback(
    async ({
      message,
      currentConversationId,
      messages,
    }: {
      message: IMessage;
      currentConversationId?: string;
      messages?: IMessage[];
    }) => {
      const targetConversationId = currentConversationId ?? conversationId;
      const res = await send(
        {
          conversation_id: targetConversationId,
          live_tts: Boolean(currentDialog?.prompt_config?.tts),
          messages: sanitizeMessagesForRequest([
            ...(Array.isArray(messages) && messages?.length > 0
              ? messages
              : (derivedMessages ?? [])),
            message,
          ]),
        },
        controllerRef.current,
      );

      if (res && (res?.response.status !== 200 || res?.data?.code !== 0)) {
        setLoadingAssistantId('');
        // cancel loading
        setValue(message.content);
        removeLatestMessage();
        return;
      }

      if (
        res?.response.status === 200 &&
        res?.data?.code === 0 &&
        currentDialog?.prompt_config?.tts &&
        targetConversationId &&
        message.id
      ) {
        void waitForAssistantVoice({
          targetConversationId,
          messageId: message.id,
        });
      }
    },
    [
      derivedMessages,
      conversationId,
      currentDialog?.prompt_config?.tts,
      removeLatestMessage,
      setValue,
      send,
      controllerRef,
      waitForAssistantVoice,
    ],
  );

  const { regenerateMessage } = useRegenerateMessage({
    removeMessagesAfterCurrentMessage,
    sendMessage,
    messages: derivedMessages,
  });

  const handleVoiceStreamEvent = useCallback(
    (event: any, targetConversationId: string) => {
      const type = event?.type;
      const data = event?.data ?? {};

      if (type === 'user_message_persisted' || type === 'user_message_ready') {
        const message = {
          ...data.message,
          role:
            data.message?.role === MessageType.Assistant
              ? MessageType.Assistant
              : MessageType.User,
          conversationId: targetConversationId,
        } as IMessage;

        upsertMessage(message.id, message.role, (previous) => ({
          ...(previous ?? message),
          ...message,
          voice: mergeVoiceMeta(previous?.voice, message.voice),
        }));
        return;
      }

      if (type === 'assistant_started') {
        const message = {
          ...data.message,
          role: MessageType.Assistant,
          conversationId: targetConversationId,
        } as IMessage;
        appendMessageIfMissing(message);
        setLoadingAssistantId(message.id);
        if (message.voice?.status === 'streaming') {
          addAutoPlayEligibleAssistant(message.id);
        }
        return;
      }

      if (type === 'assistant_delta') {
        upsertMessage(data.message_id, MessageType.Assistant, (previous) => ({
          ...(previous ?? {
            id: data.message_id,
            role: MessageType.Assistant,
            content: '',
            conversationId: targetConversationId,
          }),
          role: MessageType.Assistant,
          conversationId: targetConversationId,
          content: `${previous?.content ?? ''}${data.delta ?? ''}`,
        }));
        return;
      }

      if (type === 'assistant_done') {
        const message = {
          ...data.message,
          role: MessageType.Assistant,
          conversationId: targetConversationId,
          reference: data.reference,
        } as IMessage;

        upsertMessage(message.id, MessageType.Assistant, (previous) => ({
          ...(previous ?? message),
          ...message,
          voice: mergeVoiceMeta(previous?.voice, message.voice),
          reference: data.reference,
        }));
        if (
          autoPlayEligibleAssistantIdsRef.current.has(message.id) &&
          message.voice?.status === 'ready' &&
          message.voice.kind === 'single' &&
          message.voice.file_id
        ) {
          removeAutoPlayEligibleAssistant(message.id);
          markAssistantVoiceAutoPlay(message.id);
        } else if (message.voice?.status && message.voice.status !== 'streaming') {
          removeAutoPlayEligibleAssistant(message.id);
        }
        setLoadingAssistantId((previous) =>
          previous === message.id ? '' : previous,
        );
        return;
      }

      if (type === 'error') {
        const stage = data.stage;
        if (stage === 'asr' && data.client_message_id) {
          upsertMessage(data.client_message_id, MessageType.User, (previous) => ({
            ...(previous as IMessage),
            voice: {
              kind: previous?.voice?.kind ?? 'single',
              ...(previous?.voice ?? {}),
              status: 'failed',
              error: data.message,
            },
          }));
          return;
        }

        if (stage === 'llm' && data.message_id) {
          removeAutoPlayEligibleAssistant(data.message_id);
          setLoadingAssistantId((previous) =>
            previous === data.message_id ? '' : previous,
          );
          upsertMessage(data.message_id, MessageType.Assistant, (previous) => {
            const message = data.message as IMessage | undefined;
            const nextVoice = mergeVoiceMeta(previous?.voice, message?.voice);

            return {
              ...(previous ?? {
                id: data.message_id,
                role: MessageType.Assistant,
                content: '',
                conversationId: targetConversationId,
              }),
              ...(message ?? {}),
              role: MessageType.Assistant,
              conversationId: targetConversationId,
              content:
                message?.content ||
                previous?.content ||
                `**ERROR**: ${data.message ?? '语音回复失败'}`,
              voice: nextVoice,
              reference: data.reference ?? previous?.reference,
            };
          });
        }
      }
    },
    [
      addAutoPlayEligibleAssistant,
      appendMessageIfMissing,
      markAssistantVoiceAutoPlay,
      removeAutoPlayEligibleAssistant,
      upsertMessage,
    ],
  );

  const streamVoiceRequest = useCallback(
    async ({
      url,
      body,
      isJson = false,
      targetConversationId,
    }: {
      url: string;
      body: FormData | string;
      isJson?: boolean;
      targetConversationId: string;
    }) => {
      setVoiceLoading(true);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            [Authorization]: getAuthorization(),
            ...(isJson ? { 'Content-Type': 'application/json' } : {}),
          },
          body,
          signal: controllerRef.current.signal,
        });

        if (!response.ok) {
          throw new Error(`voice request failed: ${response.status}`);
        }

        const reader = response.body
          ?.pipeThrough(new TextDecoderStream())
          .pipeThrough(new EventSourceParserStream())
          .getReader();

        for (;;) {
          const result = await reader?.read();
          if (!result) {
            break;
          }
          const { done: readerDone, value } = result;
          if (readerDone) {
            break;
          }
          try {
            const event = JSON.parse(value?.data || '{}');
            handleVoiceStreamEvent(event, targetConversationId);
          } catch {
            // Ignore malformed SSE chunks and continue consuming the stream.
          }
        }
        return 'success' as const;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          return 'failed' as const;
        }
        return 'aborted' as const;
      } finally {
        setVoiceLoading(false);
      }
    },
    [controllerRef, handleVoiceStreamEvent],
  );

  const handlePressEnter = useCallback(async () => {
    if (trim(value) === '') return;

    const data = await createConversationBeforeSendMessage(value);

    if (data === undefined) {
      return;
    }

    const { targetConversationId, currentMessages } = data;

    const id = uuid();

    addNewestQuestion({
      content: value,
      files: files,
      id,
      role: MessageType.User,
      conversationId: targetConversationId,
    }, '', assistantVoicePlaceholder);
    setLoadingAssistantId(id);
    if (currentDialog?.prompt_config?.tts) {
      addAutoPlayEligibleAssistant(id);
    }

    if (done) {
      setValue('');
      sendMessage({
        currentConversationId: targetConversationId,
        messages: currentMessages,
        message: {
          id,
          content: value.trim(),
          role: MessageType.User,
          files: files,
          conversationId: targetConversationId,
        },
      });
    }
    clearFiles();
  }, [
    value,
    addAutoPlayEligibleAssistant,
    createConversationBeforeSendMessage,
    addNewestQuestion,
    assistantVoicePlaceholder,
    files,
    done,
    clearFiles,
    currentDialog?.prompt_config?.tts,
    setValue,
    sendMessage,
  ]);

  const handleVoiceSubmit = useCallback(
    async (payload: RecordedVoicePayload) => {
      const data = await createConversationBeforeSendMessage('Voice message');
      if (!data) {
        return;
      }

      const { targetConversationId } = data;
      const clientMessageId = buildMessageUuid({
        id: uuid(),
        role: MessageType.User,
      });

      appendMessageIfMissing({
        id: clientMessageId,
        role: MessageType.User,
        content: '',
        conversationId: targetConversationId,
        input_mode: 'voice',
        voice: {
          kind: 'single',
          status: 'transcribing',
          mime_type: payload.mimeType,
          duration_ms: payload.durationMs,
          waveform: payload.waveform,
        },
      });

      const fileExtension = getVoiceFileExtension(payload.mimeType);
      const audioFile = new File(
        [payload.blob],
        `voice-message.${fileExtension}`,
        {
          type: payload.mimeType,
        },
      );
      const formData = new FormData();
      formData.append('conversation_id', targetConversationId);
      formData.append('client_message_id', clientMessageId);
      formData.append('file', audioFile);
      formData.append('duration_ms', `${payload.durationMs}`);
      formData.append('mime_type', payload.mimeType);
      formData.append('waveform', JSON.stringify(payload.waveform ?? []));

      const result = await streamVoiceRequest({
        url: api.voiceCompletion,
        body: formData,
        targetConversationId,
      });
      if (result === 'failed') {
        upsertMessage(clientMessageId, MessageType.User, (previous) => ({
          ...(previous as IMessage),
          voice: {
            kind: previous?.voice?.kind ?? 'single',
            ...(previous?.voice ?? {}),
            status: 'failed',
            error: '发送失败',
          },
        }));
      }
    },
    [
      appendMessageIfMissing,
      createConversationBeforeSendMessage,
      streamVoiceRequest,
      upsertMessage,
    ],
  );

  const retryVoiceMessage = useCallback(
    async (messageId: string) => {
      if (!conversationId) return;
      const result = await streamVoiceRequest({
        url: api.retryVoiceCompletion,
        body: JSON.stringify({
          conversation_id: conversationId,
          message_id: messageId,
        }),
        isJson: true,
        targetConversationId: conversationId,
      });
      if (result === 'failed') {
        upsertMessage(messageId, MessageType.User, (previous) => ({
          ...(previous as IMessage),
          voice: {
            kind: previous?.voice?.kind ?? 'single',
            ...(previous?.voice ?? {}),
            status: 'failed',
            error: '重试失败',
          },
        }));
      }
    },
    [conversationId, streamVoiceRequest, upsertMessage],
  );

  const handleGenerateTable = useCallback(async () => {
    if (trim(value) !== '' || derivedMessages.length === 0) {
      toast.error('请先进行对话，再生成业务表格');
      return;
    }

    const tablePrompt = '根据上面对话信息，生成一个业务办理表格，包含：业务名称、办理条件、所需材料。用 Markdown 表格格式输出。';

    const data = await createConversationBeforeSendMessage(tablePrompt);

    if (data === undefined) {
      return;
    }

    const { targetConversationId, currentMessages } = data;

    const id = uuid();

    addNewestQuestion({
      content: tablePrompt,
      files: [],
      id,
      role: MessageType.User,
      conversationId: targetConversationId,
    }, '', assistantVoicePlaceholder);
    setLoadingAssistantId(id);
    if (currentDialog?.prompt_config?.tts) {
      addAutoPlayEligibleAssistant(id);
    }

    if (done) {
      sendMessage({
        currentConversationId: targetConversationId,
        messages: currentMessages,
        message: {
          id,
          content: tablePrompt.trim(),
          role: MessageType.User,
          files: [],
          conversationId: targetConversationId,
        },
      });
    }
  }, [
    derivedMessages,
    createConversationBeforeSendMessage,
    addNewestQuestion,
    assistantVoicePlaceholder,
    done,
    currentDialog?.prompt_config?.tts,
    sendMessage,
    addAutoPlayEligibleAssistant,
  ]);

  useEffect(() => {
    const previousConversationId = previousConversationIdRef.current;
    const switchedConversation =
      Boolean(previousConversationId) && previousConversationId !== conversationId;
    const clearedConversation = previousConversationId !== conversationId && !conversationId;

    if (switchedConversation || clearedConversation) {
      autoPlayEligibleAssistantIdsRef.current.clear();
      abortAssistantVoiceWait();
      setLoadingAssistantId('');
    }

    previousConversationIdRef.current = conversationId;
  }, [abortAssistantVoiceWait, conversationId]);

  useEffect(() => {
    const isFinalAnswer = Boolean(answer.final);
    if (answer.id && isFinalAnswer) {
      setLoadingAssistantId((previous) =>
        previous === answer.id ? '' : previous,
      );
    }

    //  #1289
    if (
      answer.id &&
      (
        answer.audio_binary ||
        (answer.voice?.kind === 'segments' &&
          (answer.voice.segments?.length ?? 0) > 0) ||
        (answer.voice?.kind === 'single' &&
          answer.voice.status === 'ready' &&
          Boolean(answer.voice.file_id))
      )
    ) {
      markAssistantVoiceAutoPlay(answer.id);
    }

    if (
      (answer.answer || answer.audio_binary || answer.voice) &&
      conversationId &&
      isNew !== 'true'
    ) {
      addNewestAnswer(answer);
    }
  }, [
    answer,
    addNewestAnswer,
    conversationId,
    isNew,
    markAssistantVoiceAutoPlay,
  ]);

  useEffect(() => {
    const eligibleAssistantIds = autoPlayEligibleAssistantIdsRef.current;
    return () => {
      eligibleAssistantIds.clear();
      abortAssistantVoiceWait();
    };
  }, [abortAssistantVoiceWait]);

  return {
    assistantVoiceAutoPlayNonceMap,
    consumeAssistantVoiceAutoPlay,
    handlePressEnter,
    handleInputChange,
    handleVoiceSubmit,
    handleGenerateTable,
    value,
    setValue,
    regenerateMessage,
    retryVoiceMessage,
    sendLoading: !done || voiceLoading,
    loadingAssistantId,
    scrollRef,
    messageContainerRef,
    derivedMessages,
    removeMessageById,
    handleUploadFile,
    isUploading,
    removeFile,
    setDerivedMessages,
  };
};
