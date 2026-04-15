import { Authorization } from '@/constants/authorization';
import { MessageType } from '@/constants/chat';
import { LanguageTranslationMap } from '@/constants/common';
import { Pagination } from '@/interfaces/common';
import { ResponseType } from '@/interfaces/database/base';
import {
  IAnswer,
  IClientConversation,
  IMessage,
  Message,
  IVoiceMeta,
} from '@/interfaces/database/chat';
import { IKnowledgeFile } from '@/interfaces/database/knowledge';
import api from '@/utils/api';
import { getAuthorization } from '@/utils/authorization-util';
import { buildMessageUuid } from '@/utils/chat';
import { hexStringToUint8Array } from '@/utils/common-util';
import { message } from 'antd';
import { FormInstance } from 'antd/lib';
import axios from 'axios';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { has, isEmpty, omit } from 'lodash';
import {
  ChangeEventHandler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useTranslate } from './common-hooks';
import { useSetPaginationParams } from './route-hook';
import { useFetchTenantInfo, useSaveSetting } from './use-user-setting-request';

export function usePrevious<T>(value: T) {
  const ref = useRef<T>();
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref.current;
}

export const useSetSelectedRecord = <T = IKnowledgeFile>() => {
  const [currentRecord, setCurrentRecord] = useState<T>({} as T);

  const setRecord = (record: T) => {
    setCurrentRecord(record);
  };

  return { currentRecord, setRecord };
};

export const useChangeLanguage = () => {
  const { i18n } = useTranslation();
  const { saveSetting } = useSaveSetting();

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(
      LanguageTranslationMap[lng as keyof typeof LanguageTranslationMap],
    );
    saveSetting({ language: lng });
  };

  return changeLanguage;
};

export const useGetPaginationWithRouter = () => {
  const { t } = useTranslate('common');
  const {
    setPaginationParams,
    page,
    size: pageSize,
  } = useSetPaginationParams();

  const onPageChange: Pagination['onChange'] = useCallback(
    (pageNumber: number, pageSize?: number) => {
      setPaginationParams(pageNumber, pageSize);
    },
    [setPaginationParams],
  );

  const setCurrentPagination = useCallback(
    (pagination: { page: number; pageSize?: number }) => {
      if (pagination.pageSize !== pageSize) {
        pagination.page = 1; // Reset to first page if pageSize changes
      }
      setPaginationParams(pagination.page, pagination.pageSize);
    },
    [setPaginationParams, pageSize],
  );

  const pagination: Pagination = useMemo(() => {
    return {
      showQuickJumper: true,
      total: 0,
      showSizeChanger: true,
      current: page,
      pageSize: pageSize,
      pageSizeOptions: [1, 2, 10, 20, 50, 100],
      onChange: onPageChange,
      showTotal: (total: number) => `${t('total')} ${total}`,
    };
  }, [t, onPageChange, page, pageSize]);

  return {
    pagination,
    setPagination: setCurrentPagination,
  };
};

export const useHandleSearchChange = () => {
  const [searchString, setSearchString] = useState('');
  const { pagination, setPagination } = useGetPaginationWithRouter();
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      setSearchString(value);
      setPagination({ page: 1 });
    },
    [setPagination],
  );

  return { handleInputChange, searchString, pagination, setPagination };
};

export const useGetPagination = () => {
  const [pagination, setPagination] = useState({ page: 1, pageSize: 10 });
  const { t } = useTranslate('common');

  const onPageChange: Pagination['onChange'] = useCallback(
    (pageNumber: number, pageSize: number) => {
      setPagination({ page: pageNumber, pageSize });
    },
    [],
  );

  const currentPagination: Pagination = useMemo(() => {
    return {
      showQuickJumper: true,
      total: 0,
      showSizeChanger: true,
      current: pagination.page,
      pageSize: pagination.pageSize,
      pageSizeOptions: [1, 2, 10, 20, 50, 100],
      onChange: onPageChange,
      showTotal: (total: number) => `${t('total')} ${total}`,
    };
  }, [t, onPageChange, pagination]);

  return {
    pagination: currentPagination,
  };
};

export interface AppConf {
  appName: string;
}

export const useFetchAppConf = () => {
  const [appConf, setAppConf] = useState<AppConf>({} as AppConf);
  const fetchAppConf = useCallback(async () => {
    const ret = await axios.get('/conf.json');

    setAppConf(ret.data);
  }, []);

  useEffect(() => {
    fetchAppConf();
  }, [fetchAppConf]);

  return appConf;
};

function useSetDoneRecord() {
  const [doneRecord, setDoneRecord] = useState<Record<string, boolean>>({});

  const clearDoneRecord = useCallback(() => {
    setDoneRecord({});
  }, []);

  const setDoneRecordById = useCallback((id: string, val: boolean) => {
    setDoneRecord((prev) => ({ ...prev, [id]: val }));
  }, []);

  const allDone = useMemo(() => {
    return Object.values(doneRecord).every((val) => val);
  }, [doneRecord]);

  useEffect(() => {
    if (!isEmpty(doneRecord) && allDone) {
      clearDoneRecord();
    }
  }, [allDone, clearDoneRecord, doneRecord]);

  return {
    doneRecord,
    setDoneRecord,
    setDoneRecordById,
    clearDoneRecord,
    allDone,
  };
}

export const useSendMessageWithSse = (
  url: string = api.completeConversation,
) => {
  const [answer, setAnswer] = useState<IAnswer>({} as IAnswer);
  const [done, setDone] = useState(true);
  const { doneRecord, clearDoneRecord, setDoneRecordById, allDone } =
    useSetDoneRecord();
  const timer = useRef<any>();
  const sseRef = useRef<AbortController>();

  const initializeSseRef = useCallback(() => {
    sseRef.current = new AbortController();
  }, []);

  const resetAnswer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => {
      setAnswer({} as IAnswer);
      clearTimeout(timer.current);
    }, 1000);
  }, []);

  const setDoneValue = useCallback(
    (body: any, value: boolean) => {
      if (has(body, 'chatBoxId')) {
        setDoneRecordById(body.chatBoxId, value);
      } else {
        setDone(value);
      }
    },
    [setDoneRecordById],
  );

  const send = useCallback(
    async (
      body: any,
      controller?: AbortController,
    ): Promise<{ response: Response; data: ResponseType } | undefined> => {
      initializeSseRef();
      try {
        setDoneValue(body, false);
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            [Authorization]: getAuthorization(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(omit(body, 'chatBoxId')),
          signal: controller?.signal || sseRef.current?.signal,
        });

        const contentType =
          response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() ||
          '';
        const isJsonResponse = contentType.includes('json');
        const res = isJsonResponse
          ? response.clone().json()
          : Promise.resolve({
              code: response.ok ? 0 : response.status,
              data: true,
              message: '',
              status: response.status,
            } as ResponseType);

        const reader = response?.body
          ?.pipeThrough(new TextDecoderStream())
          .pipeThrough(new EventSourceParserStream())
          .getReader();

        for (;;) {
          try {
            const x = await reader?.read();
            if (x) {
              const { done, value } = x;
              if (done) {
                resetAnswer();
                break;
              }
              try {
                const val = JSON.parse(value?.data || '');
                const d = val?.data;
                if (typeof d !== 'boolean') {
                  setAnswer((prev) => {
                    const newAnswer = (prev.answer || '') + (d.answer || '');

                    return {
                      ...d,
                      answer: newAnswer,
                      conversationId: body?.conversation_id,
                      chatBoxId: body.chatBoxId,
                    };
                  });
                }
              } catch {
                // Swallow parse errors silently
              }
            }
          } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
              break;
            }
          }
        }
        setDoneValue(body, true);
        resetAnswer();
        return { data: await res, response };
      } catch {
        setDoneValue(body, true);

        resetAnswer();
        // Swallow fetch errors silently
      }
    },
    [initializeSseRef, setDoneValue, url, resetAnswer],
  );

  const stopOutputMessage = useCallback(() => {
    sseRef.current?.abort();
  }, []);

  return {
    send,
    answer,
    done,
    doneRecord,
    allDone,
    setDone,
    resetAnswer,
    stopOutputMessage,
    clearDoneRecord,
  };
};

export const useSpeechWithSse = (url: string = api.tts) => {
  const read = useCallback(
    async (body: any) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          [Authorization]: getAuthorization(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const contentType =
        response.headers
          .get('Content-Type')
          ?.split(';', 1)[0]
          .trim()
          .toLowerCase() || '';

      if (contentType && !contentType.includes('json')) {
        return response;
      }

      try {
        const res = await response.clone().json();
        if (res?.code !== 0) {
          message.error(res?.message);
        }
      } catch {
        // Swallow errors silently
      }
      return response;
    },
    [url],
  );

  return { read };
};

//#region chat hooks

export const useScrollToBottom = (
  messages?: unknown,
  containerRef?: React.RefObject<HTMLDivElement>,
) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);

  useEffect(() => {
    isAtBottomRef.current = isAtBottom;
  }, [isAtBottom]);

  const checkIfUserAtBottom = useCallback(() => {
    if (!containerRef?.current) return true;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    return Math.abs(scrollTop + clientHeight - scrollHeight) < 25;
  }, [containerRef]);

  useEffect(() => {
    if (!containerRef?.current) return;
    const container = containerRef.current;

    const handleScroll = () => {
      setIsAtBottom(checkIfUserAtBottom());
    };

    container.addEventListener('scroll', handleScroll);
    handleScroll();
    return () => container.removeEventListener('scroll', handleScroll);
  }, [containerRef, checkIfUserAtBottom]);

  // Imperative scroll function
  const scrollToBottom = useCallback(() => {
    if (containerRef?.current) {
      const container = containerRef.current;
      container.scrollTo({
        top: container.scrollHeight - container.clientHeight,
        behavior: 'smooth',
      });
    }
  }, [containerRef]);

  useEffect(() => {
    if (!messages) return;
    if (!containerRef?.current) return;
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (isAtBottomRef.current) {
          scrollToBottom();
        }
      }, 100);
    });
  }, [messages, containerRef, scrollToBottom]);

  return { scrollRef: ref, isAtBottom, scrollToBottom };
};

export const useHandleMessageInputChange = () => {
  const [value, setValue] = useState('');

  const handleInputChange: ChangeEventHandler<HTMLTextAreaElement> = (e) => {
    const value = e.target.value;
    const nextValue = value.replaceAll('\\n', '\n').replaceAll('\\t', '\t');
    setValue(nextValue);
  };

  return {
    handleInputChange,
    value,
    setValue,
  };
};

const detectEmbeddedAudioMimeType = (
  units?: Uint8Array,
  fallback?: string,
) => {
  const normalizedFallback = fallback?.split(';', 1)[0].trim().toLowerCase();
  if (normalizedFallback) {
    return normalizedFallback;
  }
  if (!units?.length) {
    return 'audio/mpeg';
  }
  if (units.length >= 12) {
    const header = String.fromCharCode(...units.slice(0, 4));
    const format = String.fromCharCode(...units.slice(8, 12));
    if (header === 'RIFF' && format === 'WAVE') {
      return 'audio/wav';
    }
  }
  if (units.length >= 4) {
    const header = String.fromCharCode(...units.slice(0, 4));
    if (header === 'OggS') {
      return 'audio/ogg';
    }
    if (header === 'fLaC') {
      return 'audio/flac';
    }
  }
  if (
    units.length >= 4 &&
    units[0] === 0x1a &&
    units[1] === 0x45 &&
    units[2] === 0xdf &&
    units[3] === 0xa3
  ) {
    return 'audio/webm';
  }
  if (
    units.length >= 8 &&
    String.fromCharCode(...units.slice(4, 8)) === 'ftyp'
  ) {
    return 'audio/mp4';
  }
  if (
    (units.length >= 3 &&
      String.fromCharCode(...units.slice(0, 3)) === 'ID3') ||
    (units.length >= 2 && units[0] === 0xff && (units[1] & 0xe0) === 0xe0)
  ) {
    return 'audio/mpeg';
  }
  return 'audio/mpeg';
};

const mergeStreamingVoice = (
  previousVoice: IVoiceMeta | undefined,
  answer: IAnswer,
): IVoiceMeta | undefined => {
  if (answer.voice) {
    if (answer.voice.kind === 'segments') {
      const previousSegments =
        previousVoice?.kind === 'segments' ? previousVoice.segments ?? [] : [];
      const incomingSegments = answer.voice.segments ?? [];
      const mergedSegmentsMap = new Map<number, (typeof previousSegments)[number]>();

      previousSegments.forEach((segment) => {
        mergedSegmentsMap.set(segment.seq, segment);
      });
      incomingSegments.forEach((segment) => {
        const previousSegment = mergedSegmentsMap.get(segment.seq);
        mergedSegmentsMap.set(segment.seq, {
          ...(previousSegment ?? {}),
          ...segment,
          object_url: segment.file_id
            ? undefined
            : segment.object_url ?? previousSegment?.object_url,
        });
      });

      return {
        ...(previousVoice?.kind === 'segments' ? previousVoice : {}),
        ...answer.voice,
        kind: 'segments',
        file_id: undefined,
        local_url: undefined,
        mime_type: answer.voice.mime_type ?? previousVoice?.mime_type,
        segments: [...mergedSegmentsMap.values()].sort(
          (left, right) => left.seq - right.seq,
        ),
      };
    }

    if (
      previousVoice?.kind === 'segments' &&
      (previousVoice.segments?.length ?? 0) > 0
    ) {
      return {
        ...previousVoice,
        status:
          answer.final && previousVoice.status !== 'failed'
            ? 'ready'
            : previousVoice.status,
        file_id: undefined,
        local_url: undefined,
        mime_type: answer.voice.mime_type ?? previousVoice.mime_type,
        duration_ms: answer.voice.duration_ms ?? previousVoice.duration_ms,
      };
    }
    return answer.voice;
  }

  if (previousVoice?.kind === 'segments' && answer.final) {
    return {
      ...previousVoice,
      status:
        previousVoice.status !== 'failed' &&
        (previousVoice.segments?.length ?? 0) > 0
          ? 'ready'
          : previousVoice.status,
      mime_type: answer.audio_mime_type ?? previousVoice.mime_type,
    };
  }

  if (!answer.audio_binary) {
    return previousVoice;
  }

  const units = hexStringToUint8Array(answer.audio_binary);
  if (!units?.length) {
    return previousVoice;
  }

  const mimeType = detectEmbeddedAudioMimeType(units, answer.audio_mime_type);
  const prevSegments =
    previousVoice?.kind === 'segments' ? previousVoice.segments ?? [] : [];
  const nextSeq =
    prevSegments.reduce((max, segment) => Math.max(max, segment.seq), 0) + 1;
  const objectUrl = URL.createObjectURL(new Blob([units], { type: mimeType }));

  return {
    kind: 'segments',
    status: answer.final ? 'ready' : 'streaming',
    mime_type: mimeType,
    segments: [
      ...prevSegments,
      {
        seq: nextSeq,
        file_id: '',
        mime_type: mimeType,
        duration_ms: 0,
        object_url: objectUrl,
      },
    ],
  };
};

export const useSelectDerivedMessages = () => {
  const [derivedMessages, setDerivedMessages] = useState<IMessage[]>([]);

  const messageContainerRef = useRef<HTMLDivElement>(null);

  const { scrollRef, scrollToBottom } = useScrollToBottom(
    derivedMessages,
    messageContainerRef,
  );

  const addNewestQuestion = useCallback(
    (
      message: IMessage,
      answer: string = '',
      assistantVoice?: IVoiceMeta,
    ) => {
      setDerivedMessages((pre) => {
        return [
          ...pre,
          {
            ...message,
            id: buildMessageUuid(message), // The message id is generated on the front end,
            // and the message id returned by the back end is the same as the question id,
            //  so that the pair of messages can be deleted together when deleting the message
          },
          {
            role: MessageType.Assistant,
            content: answer,
            conversationId: message.conversationId,
            id: buildMessageUuid({ ...message, role: MessageType.Assistant }),
            voice: assistantVoice,
          },
        ];
      });
    },
    [],
  );

  const addNewestOneQuestion = useCallback((message: Message) => {
    setDerivedMessages((pre) => {
      return [
        ...pre,
        {
          ...message,
          id: buildMessageUuid(message), // The message id is generated on the front end,
          // and the message id returned by the back end is the same as the question id,
          //  so that the pair of messages can be deleted together when deleting the message
        },
      ];
    });
  }, []);

  // Add the streaming message to the last item in the message list
  const addNewestAnswer = useCallback((answer: IAnswer) => {
    setDerivedMessages((pre) => {
      let assistantIndex = -1;
      if (typeof answer.id === 'string') {
        for (let index = pre.length - 1; index >= 0; index -= 1) {
          if (
            pre[index].role === MessageType.Assistant &&
            pre[index].id === answer.id
          ) {
            assistantIndex = index;
            break;
          }
        }
      }
      const targetIndex =
        assistantIndex >= 0 ? assistantIndex : Math.max(0, pre.length - 1);
      const previousMessage =
        targetIndex >= 0 ? pre[targetIndex] : undefined;
      const nextMessage = {
        ...(previousMessage ?? {}),
        role: MessageType.Assistant,
        content: answer.answer,
        id: buildMessageUuid({
          id: answer.id,
          role: MessageType.Assistant,
        }),
        ...omit(answer, 'reference'),
        reference: isEmpty(answer.reference)
          ? previousMessage?.reference
          : answer.reference,
        prompt: answer.prompt ?? previousMessage?.prompt,
        audio_binary: answer.audio_binary ?? previousMessage?.audio_binary,
        voice: mergeStreamingVoice(previousMessage?.voice, answer),
      };

      if (targetIndex < 0) {
        return [nextMessage];
      }

      return pre.map((message, index) =>
        index === targetIndex ? nextMessage : message,
      );
    });
  }, []);

  // Add the streaming message to the last item in the message list
  const addNewestOneAnswer = useCallback((answer: IAnswer) => {
    setDerivedMessages((pre) => {
      const idx = pre.findIndex((x) => x.id === answer.id);

      if (idx !== -1) {
        return pre.map((x) => {
          if (x.id === answer.id) {
            return {
              ...x,
              ...answer,
              content: answer.answer,
              reference: isEmpty(answer.reference)
                ? x.reference
                : answer.reference,
              voice: mergeStreamingVoice(x.voice, answer),
            };
          }
          return x;
        });
      }

      return [
        ...(pre ?? []),
        {
          role: MessageType.Assistant,
          content: answer.answer,
          id: buildMessageUuid({
            id: answer.id,
            role: MessageType.Assistant,
          }),
          prompt: answer.prompt,
          audio_binary: answer.audio_binary,
          ...omit(answer, 'reference'),
          reference: answer.reference,
          voice: mergeStreamingVoice(undefined, answer),
        },
      ];
    });
  }, []);

  const addPrologue = useCallback((prologue: string) => {
    setDerivedMessages((pre) => {
      if (pre.length > 0) {
        return [
          {
            ...pre[0],
            content: prologue,
          },
          ...pre.slice(1),
        ];
      }

      return [
        {
          role: MessageType.Assistant,
          content: prologue,
          id: buildMessageUuid({
            role: MessageType.Assistant,
          }),
        },
      ];
    });
  }, []);

  const removeLatestMessage = useCallback(() => {
    setDerivedMessages((pre) => {
      const nextMessages = pre?.slice(0, -2) ?? [];
      return nextMessages;
    });
  }, []);

  const removeMessageById = useCallback(
    (messageId: string) => {
      setDerivedMessages((pre) => {
        const nextMessages = pre?.filter((x) => x.id !== messageId) ?? [];
        return nextMessages;
      });
    },
    [setDerivedMessages],
  );

  const removeMessagesAfterCurrentMessage = useCallback(
    (messageId: string) => {
      setDerivedMessages((pre) => {
        const index = pre.findIndex((x) => x.id === messageId);
        if (index !== -1) {
          let nextMessages = pre.slice(0, index + 2) ?? [];
          const latestMessage = nextMessages.at(-1);
          nextMessages = latestMessage
            ? [
                ...nextMessages.slice(0, -1),
                {
                  ...latestMessage,
                  content: '',
                  reference: undefined,
                  prompt: undefined,
                },
              ]
            : nextMessages;
          return nextMessages;
        }
        return pre;
      });
    },
    [setDerivedMessages],
  );

  const removeAllMessages = useCallback(() => {
    setDerivedMessages([]);
  }, [setDerivedMessages]);

  const removeAllMessagesExceptFirst = useCallback(() => {
    setDerivedMessages((list) => {
      if (list.length <= 1) {
        return list;
      }
      return list.slice(0, 1);
    });
  }, [setDerivedMessages]);

  return {
    scrollRef,
    messageContainerRef,
    derivedMessages,
    setDerivedMessages,
    addNewestQuestion,
    addNewestAnswer,
    removeLatestMessage,
    removeMessageById,
    addNewestOneQuestion,
    addNewestOneAnswer,
    removeMessagesAfterCurrentMessage,
    removeAllMessages,
    scrollToBottom,
    removeAllMessagesExceptFirst,
    addPrologue,
  };
};

export interface IRemoveMessageById {
  removeMessageById(messageId: string): void;
}

export const useRemoveMessagesAfterCurrentMessage = (
  setCurrentConversation: (
    callback: (state: IClientConversation) => IClientConversation,
  ) => void,
) => {
  const removeMessagesAfterCurrentMessage = useCallback(
    (messageId: string) => {
      setCurrentConversation((pre) => {
        const index = pre.message?.findIndex((x) => x.id === messageId);
        if (index !== -1) {
          let nextMessages = pre.message?.slice(0, index + 2) ?? [];
          const latestMessage = nextMessages.at(-1);
          nextMessages = latestMessage
            ? [
                ...nextMessages.slice(0, -1),
                {
                  ...latestMessage,
                  content: '',
                  reference: undefined,
                  prompt: undefined,
                },
              ]
            : nextMessages;
          return {
            ...pre,
            message: nextMessages,
          };
        }
        return pre;
      });
    },
    [setCurrentConversation],
  );

  return { removeMessagesAfterCurrentMessage };
};

export interface IRegenerateMessage {
  regenerateMessage?: (message: Message) => void;
}

export const useRegenerateMessage = ({
  removeMessagesAfterCurrentMessage,
  sendMessage,
  messages,
}: {
  removeMessagesAfterCurrentMessage(messageId: string): void;
  sendMessage({
    message,
  }: {
    message: Message;
    messages?: Message[];
  }): void | Promise<any>;
  messages: Message[];
}) => {
  const regenerateMessage = useCallback(
    async (message: Message) => {
      if (message.id) {
        removeMessagesAfterCurrentMessage(message.id);
        const index = messages.findIndex((x) => x.id === message.id);
        let nextMessages;
        if (index !== -1) {
          nextMessages = messages.slice(0, index);
        }
        sendMessage({
          message: { ...message, id: uuid() },
          messages: nextMessages,
        });
      }
    },
    [removeMessagesAfterCurrentMessage, sendMessage, messages],
  );

  return { regenerateMessage };
};

// #endregion

/**
 *
 * @param defaultId
 * used to switch between different items, similar to radio
 * @returns
 */
export const useSelectItem = (defaultId?: string) => {
  const [selectedId, setSelectedId] = useState('');

  const handleItemClick = useCallback(
    (id: string) => () => {
      setSelectedId(id);
    },
    [],
  );

  useEffect(() => {
    if (defaultId) {
      setSelectedId(defaultId);
    }
  }, [defaultId]);

  return { selectedId, handleItemClick };
};

export const useFetchModelId = () => {
  const { data: tenantInfo } = useFetchTenantInfo(true);

  return tenantInfo?.llm_id ?? '';
};

const ChunkTokenNumMap = {
  naive: 128,
  knowledge_graph: 8192,
};

export const useHandleChunkMethodSelectChange = (form: FormInstance) => {
  // const form = Form.useFormInstance();
  const handleChange = useCallback(
    (value: string) => {
      if (value in ChunkTokenNumMap) {
        form.setFieldValue(
          ['parser_config', 'chunk_token_num'],
          ChunkTokenNumMap[value as keyof typeof ChunkTokenNumMap],
        );
      }
    },
    [form],
  );

  return handleChange;
};

// reset form fields when modal is form, closed
export const useResetFormOnCloseModal = ({
  form,
  visible,
}: {
  form: FormInstance;
  visible?: boolean;
}) => {
  const prevOpenRef = useRef<boolean>();
  useEffect(() => {
    prevOpenRef.current = visible;
  }, [visible]);
  const prevOpen = prevOpenRef.current;

  useEffect(() => {
    if (!visible && prevOpen) {
      form.resetFields();
    }
  }, [form, prevOpen, visible]);
};
