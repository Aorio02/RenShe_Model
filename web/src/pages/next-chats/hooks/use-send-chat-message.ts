import { Authorization } from '@/constants/authorization';
import { MessageType } from '@/constants/chat';
import {
  useHandleMessageInputChange,
  useRegenerateMessage,
  useSelectDerivedMessages,
  useSendMessageWithSse,
} from '@/hooks/logic-hooks';
import { useGetChatSearchParams } from '@/hooks/use-chat-request';
import { IMessage } from '@/interfaces/database/chat';
import { RecordedVoicePayload } from '@/components/ui/audio-button';
import api from '@/utils/api';
import {
  buildMessageUuid,
  removeThinkBlocks,
  sanitizeMessagesForRequest,
} from '@/utils/chat';
import { getAuthorization } from '@/utils/authorization-util';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { trim } from 'lodash';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { v4 as uuid } from 'uuid';
import { useCreateConversationBeforeSendMessage } from './use-chat-url';
import { useFindPrologueFromDialogList } from './use-select-conversation-list';
import { useUploadFile } from './use-upload-file';

const LIVE_TTS_MIN_CHARS = 12;
const LIVE_TTS_MAX_CHARS = 40;
const LIVE_TTS_PUNCTUATION = '。！？；!?;';

type LiveTtsState = {
  rawContent: string;
  renderedText: string;
  pendingBuffer: string;
};

const normalizeLiveTtsText = (text: string = '') => {
  return removeThinkBlocks(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+|www\.\S+/g, ' ')
    .replace(/\[ID:\d+\]|##\d+\$\$|<[^>]+>/g, ' ')
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
};

const getCommonPrefixLength = (left: string, right: string) => {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) {
    index += 1;
  }
  return index;
};

const splitLiveTtsBuffer = (buffer: string, force: boolean = false) => {
  const outputs: string[] = [];
  let pending = buffer;

  while (pending.length >= LIVE_TTS_MIN_CHARS) {
    const scanLimit = Math.min(pending.length, LIVE_TTS_MAX_CHARS);
    let splitIndex = -1;

    for (let index = scanLimit - 1; index >= 0; index -= 1) {
      if (LIVE_TTS_PUNCTUATION.includes(pending[index])) {
        splitIndex = index;
        break;
      }
    }

    if (splitIndex < 0) {
      break;
    }

    outputs.push(pending.slice(0, splitIndex + 1).trim());
    pending = pending.slice(splitIndex + 1).trimStart();
  }

  while (pending.length >= LIVE_TTS_MAX_CHARS) {
    outputs.push(pending.slice(0, LIVE_TTS_MAX_CHARS).trim());
    pending = pending.slice(LIVE_TTS_MAX_CHARS).trimStart();
  }

  if (force && pending.trim()) {
    outputs.push(pending.trim());
    pending = '';
  }

  return [outputs.filter(Boolean), pending] as const;
};

const hasReadableChinese = (text: string) => /[\u4e00-\u9fff]/.test(text);

const sortVoiceSegments = (
  segments: NonNullable<IMessage['voice']>['segments'] = [],
) => {
  return [...segments].sort((a, b) => a.seq - b.seq);
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

export const useSendMessage = (controller: AbortController) => {
  const { conversationId, isNew } = useGetChatSearchParams();
  const { handleInputChange, value, setValue } = useHandleMessageInputChange();
  const [voiceLoading, setVoiceLoading] = useState(false);
  const liveReplyStateRef = useRef<Map<string, LiveTtsState>>(new Map());
  const liveTtsQueueRef = useRef<Array<{ messageId: string; text: string }>>([]);
  const liveTtsAudioRef = useRef<HTMLAudioElement | null>(null);
  const liveTtsPlayingRef = useRef(false);
  const liveTtsBlockedRef = useRef(false);
  const liveTtsUrlsRef = useRef<Set<string>>(new Set());

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
      const res = await send(
        {
          conversation_id: currentConversationId ?? conversationId,
          messages: sanitizeMessagesForRequest([
            ...(Array.isArray(messages) && messages?.length > 0
              ? messages
              : (derivedMessages ?? [])),
            message,
          ]),
        },
        controller,
      );

      if (res && (res?.response.status !== 200 || res?.data?.code !== 0)) {
        // cancel loading
        setValue(message.content);
        removeLatestMessage();
      }
    },
    [
      derivedMessages,
      conversationId,
      removeLatestMessage,
      setValue,
      send,
      controller,
    ],
  );

  const { regenerateMessage } = useRegenerateMessage({
    removeMessagesAfterCurrentMessage,
    sendMessage,
    messages: derivedMessages,
  });

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

  const revokeLiveTtsUrls = useCallback(() => {
    liveTtsUrlsRef.current.forEach((url) => {
      if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    });
    liveTtsUrlsRef.current.clear();
  }, []);

  const fetchLiveTtsAudioUrl = useCallback(async (text: string) => {
    const response = await fetch(api.tts, {
      method: 'POST',
      headers: {
        [Authorization]: getAuthorization(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    const contentType =
      response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() ||
      '';

    if (!response.ok || contentType.includes('json')) {
      throw new Error(`tts request failed: ${response.status}`);
    }

    const blob = await response.blob();
    if (!blob.size) {
      throw new Error('voice file is empty');
    }

    const objectUrl = URL.createObjectURL(blob);
    liveTtsUrlsRef.current.add(objectUrl);
    return objectUrl;
  }, []);

  const playLiveTtsQueue = useCallback(async () => {
    const audio = liveTtsAudioRef.current;
    if (!audio || liveTtsPlayingRef.current || liveTtsBlockedRef.current) {
      return;
    }

    liveTtsPlayingRef.current = true;
    try {
      while (liveTtsQueueRef.current.length > 0) {
        const item = liveTtsQueueRef.current.shift();
        if (!item || !hasReadableChinese(item.text)) {
          continue;
        }

        const objectUrl = await fetchLiveTtsAudioUrl(item.text);
        audio.pause();
        audio.currentTime = 0;
        audio.src = objectUrl;
        audio.load();
        await audio.play();
        await new Promise<void>((resolve, reject) => {
          let onEnded: () => void = () => {};
          let onError: () => void = () => {};
          const cleanup = () => {
            audio.removeEventListener('ended', onEnded);
            audio.removeEventListener('error', onError);
          };
          onEnded = () => {
            cleanup();
            resolve();
          };
          onError = () => {
            cleanup();
            reject(new Error('live tts playback failed'));
          };
          audio.addEventListener('ended', onEnded);
          audio.addEventListener('error', onError);
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        liveTtsBlockedRef.current = true;
      }
      liveTtsQueueRef.current = [];
    } finally {
      liveTtsPlayingRef.current = false;
    }
  }, [fetchLiveTtsAudioUrl]);

  const enqueueLiveTtsText = useCallback(
    (messageId: string, rawContent: string, force: boolean = false) => {
      const previous =
        liveReplyStateRef.current.get(messageId) ?? {
          rawContent: '',
          renderedText: '',
          pendingBuffer: '',
        };
      const nextRenderedText = normalizeLiveTtsText(rawContent);
      const prefixLength = nextRenderedText.startsWith(previous.renderedText)
        ? previous.renderedText.length
        : getCommonPrefixLength(previous.renderedText, nextRenderedText);
      const nextPendingBuffer =
        (prefixLength < previous.renderedText.length ? '' : previous.pendingBuffer) +
        nextRenderedText.slice(prefixLength);
      const [segments, rest] = splitLiveTtsBuffer(nextPendingBuffer, force);

      if (force) {
        liveReplyStateRef.current.delete(messageId);
      } else {
        liveReplyStateRef.current.set(messageId, {
          rawContent,
          renderedText: nextRenderedText,
          pendingBuffer: rest,
        });
      }

      segments.forEach((segment) => {
        if (segment.trim()) {
          liveTtsQueueRef.current.push({ messageId, text: segment.trim() });
        }
      });

      void playLiveTtsQueue();
    },
    [playLiveTtsQueue],
  );

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
          voice: message.voice
            ? {
                ...(previous?.voice ?? {}),
                ...(message.voice ?? {}),
                local_url: message.voice?.file_id
                  ? undefined
                  : previous?.voice?.local_url,
              }
            : undefined,
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
        if (message.input_mode === 'voice') {
          liveReplyStateRef.current.set(message.id, {
            rawContent: message.content ?? '',
            renderedText: normalizeLiveTtsText(message.content ?? ''),
            pendingBuffer: '',
          });
        }
        return;
      }

      if (type === 'assistant_delta') {
        let nextContent = '';
        upsertMessage(data.message_id, MessageType.Assistant, (previous) => ({
          ...(previous ?? {
            id: data.message_id,
            role: MessageType.Assistant,
            content: '',
            conversationId: targetConversationId,
          }),
          role: MessageType.Assistant,
          conversationId: targetConversationId,
          content: (() => {
            nextContent = `${previous?.content ?? ''}${data.delta ?? ''}`;
            return nextContent;
          })(),
        }));
        if (liveReplyStateRef.current.has(data.message_id)) {
          enqueueLiveTtsText(data.message_id, nextContent, false);
        }
        return;
      }

      if (type === 'assistant_audio_segment') {
        upsertMessage(data.message_id, MessageType.Assistant, (previous) => {
          const existingSegments = previous?.voice?.segments ?? [];
          const nextSegments = existingSegments.some(
            (segment) => segment.seq === data.seq,
          )
            ? existingSegments
            : sortVoiceSegments([
                ...existingSegments,
                {
                  seq: data.seq,
                  file_id: data.file_id || '',
                  mime_type: data.mime_type || 'audio/mpeg',
                  duration_ms: 0,
                  text: data.text,
                },
              ]);

          return {
            ...(previous ?? {
              id: data.message_id,
              role: MessageType.Assistant,
              content: '',
              conversationId: targetConversationId,
            }),
            role: MessageType.Assistant,
            conversationId: targetConversationId,
            voice: {
              kind: 'segments',
              status: 'streaming',
              mime_type: data.mime_type || 'audio/mpeg',
              segments: nextSegments,
            },
          } as IMessage;
        });
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
          voice: message.voice
            ? {
                ...(previous?.voice ?? {}),
                ...(message.voice ?? {}),
                segments: sortVoiceSegments(
                  (message.voice?.segments ?? []).map((segment) => {
                    const previousSegment = previous?.voice?.segments?.find(
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
              }
            : undefined,
          reference: data.reference,
        }));
        if (liveReplyStateRef.current.has(message.id)) {
          enqueueLiveTtsText(message.id, message.content ?? '', true);
        }
        return;
      }

      if (type === 'error') {
        const stage = data.stage;
        if (stage === 'asr' && data.client_message_id) {
          upsertMessage(data.client_message_id, MessageType.User, (previous) => ({
            ...(previous as IMessage),
            voice: {
              ...(previous?.voice ?? {}),
              status: 'failed',
              error: data.message,
            },
          }));
          return;
        }

        if (stage === 'llm' && data.message_id) {
          liveReplyStateRef.current.delete(data.message_id);
          upsertMessage(data.message_id, MessageType.Assistant, (previous) => {
            const message = data.message as IMessage | undefined;
            const nextVoice = message?.voice
              ? {
                  ...(previous?.voice ?? {}),
                  ...(message.voice ?? {}),
                  segments: sortVoiceSegments(
                    (message.voice?.segments ?? []).map((segment) => {
                      const previousSegment = previous?.voice?.segments?.find(
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
                }
              : undefined;

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
    [appendMessageIfMissing, enqueueLiveTtsText, upsertMessage],
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
          signal: controller.signal,
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
    [controller, handleVoiceStreamEvent],
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
    });

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
    createConversationBeforeSendMessage,
    addNewestQuestion,
    files,
    done,
    clearFiles,
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
            ...(previous?.voice ?? {}),
            status: 'failed',
            error: '重试失败',
          },
        }));
      }
    },
    [conversationId, streamVoiceRequest, upsertMessage],
  );

  useEffect(() => {
    const audio = new Audio();
    const replyState = liveReplyStateRef.current;
    audio.preload = 'none';
    liveTtsAudioRef.current = audio;

    return () => {
      liveTtsAudioRef.current?.pause();
      if (liveTtsAudioRef.current) {
        liveTtsAudioRef.current.removeAttribute('src');
        liveTtsAudioRef.current.load();
      }
      liveTtsAudioRef.current = null;
      liveTtsQueueRef.current = [];
      replyState.clear();
      liveTtsPlayingRef.current = false;
      liveTtsBlockedRef.current = false;
      revokeLiveTtsUrls();
    };
  }, [revokeLiveTtsUrls]);

  useEffect(() => {
    //  #1289
    if (answer.answer && conversationId && isNew !== 'true') {
      addNewestAnswer(answer);
    }
  }, [answer, addNewestAnswer, conversationId, isNew]);

  return {
    handlePressEnter,
    handleInputChange,
    handleVoiceSubmit,
    value,
    setValue,
    regenerateMessage,
    retryVoiceMessage,
    sendLoading: !done || voiceLoading,
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
