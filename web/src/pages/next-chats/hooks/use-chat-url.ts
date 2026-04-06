import { ChatSearchParams } from '@/constants/chat';
import { useGetChatSearchParams } from '@/hooks/use-chat-request';
import { IMessage } from '@/interfaces/database/chat';
import { generateConversationId } from '@/utils/chat';
import { useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { useSetConversation } from './use-set-conversation';

/**
 * Consolidated hook for managing chat URL parameters (conversationId and isNew)
 * Replaces: useClickConversationCard from use-chat-request.ts and useSetChatRouteParams from use-set-chat-route.ts
 */
export const useChatUrlParams = () => {
  const [currentQueryParameters, setSearchParams] = useSearchParams();

  const updateSearchParams = useCallback(
    (updater: (params: URLSearchParams) => void) => {
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous);
        updater(next);
        return next;
      });
    },
    [setSearchParams],
  );

  const setConversationId = useCallback(
    (conversationId: string) => {
      updateSearchParams((params) => {
        if (conversationId) {
          params.set(ChatSearchParams.ConversationId, conversationId);
          return;
        }
        params.delete(ChatSearchParams.ConversationId);
      });
    },
    [updateSearchParams],
  );

  const setIsNew = useCallback(
    (isNew: string) => {
      updateSearchParams((params) => {
        if (isNew) {
          params.set(ChatSearchParams.isNew, isNew);
          return;
        }
        params.delete(ChatSearchParams.isNew);
      });
    },
    [updateSearchParams],
  );

  const getIsNew = useCallback(() => {
    return currentQueryParameters.get(ChatSearchParams.isNew);
  }, [currentQueryParameters]);

  const setConversationBoth = useCallback(
    (conversationId: string, isNew: string) => {
      updateSearchParams((params) => {
        if (conversationId) {
          params.set(ChatSearchParams.ConversationId, conversationId);
        } else {
          params.delete(ChatSearchParams.ConversationId);
        }

        if (isNew) {
          params.set(ChatSearchParams.isNew, isNew);
        } else {
          params.delete(ChatSearchParams.isNew);
        }
      });
    },
    [updateSearchParams],
  );

  return {
    setConversationId,
    setIsNew,
    getIsNew,
    setConversationBoth,
  };
};

export function useCreateConversationBeforeSendMessage() {
  const { conversationId, isNew } = useGetChatSearchParams();
  const { setConversation } = useSetConversation();
  const { setConversationBoth } = useChatUrlParams();
  const pendingCreationRef = useRef<
    Promise<
      | {
          targetConversationId: string;
          currentMessages: Array<IMessage>;
        }
      | undefined
    >
    | null
  >(null);

  // Create conversation if it doesn't exist
  const createConversationBeforeSendMessage = useCallback(
    async (value: string) => {
      if (pendingCreationRef.current) {
        return pendingCreationRef.current;
      }

      let currentMessages: Array<IMessage> = [];
      const currentConversationId = conversationId || generateConversationId();
      if (conversationId === '' || isNew === 'true') {
        pendingCreationRef.current = (async () => {
          try {
            if (conversationId === '') {
              setConversationBoth(currentConversationId, 'true');
            }

            const data = await setConversation(value, true, currentConversationId);
            if (data.code !== 0) {
              if (conversationId === '') {
                setConversationBoth('', '');
              }
              return;
            }

            setConversationBoth(currentConversationId, '');
            currentMessages = data.data.message;

            return {
              targetConversationId: currentConversationId,
              currentMessages,
            };
          } finally {
            pendingCreationRef.current = null;
          }
        })();

        return pendingCreationRef.current;
      }

      return {
        targetConversationId: currentConversationId,
        currentMessages,
      };
    },
    [conversationId, isNew, setConversation, setConversationBoth],
  );

  return {
    createConversationBeforeSendMessage,
  };
}
