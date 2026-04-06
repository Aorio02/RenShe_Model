import { useCallback, useRef } from 'react';
import { useChatUrlParams } from './use-chat-url';

export function useHandleClickConversationCard() {
  const controllerRef = useRef(new AbortController());
  const { setConversationBoth } = useChatUrlParams();

  const stopOutputMessage = useCallback(() => {
    controllerRef.current.abort();
    controllerRef.current = new AbortController();
  }, []);

  const handleConversationCardClick = useCallback(
    (conversationId: string, isNew: boolean) => {
      stopOutputMessage();
      setConversationBoth(conversationId, isNew ? 'true' : '');
    },
    [setConversationBoth, stopOutputMessage],
  );

  return { controllerRef, handleConversationCardClick, stopOutputMessage };
}
