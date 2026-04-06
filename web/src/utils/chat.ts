import {
  ChatVariableEnabledField,
  EmptyConversationId,
} from '@/constants/chat';
import { IMessage, Message } from '@/interfaces/database/chat';
import { omit } from 'lodash';
import { v4 as uuid } from 'uuid';

const RequestTransientMessageFields = [
  'answer',
  'audio_binary',
  'audio_mime_type',
  'chatBoxId',
  'conversationId',
  'created_at',
  'data',
  'final',
  'prompt',
  'reference',
  'session_id',
] as const;

export const isConversationIdExist = (conversationId: string) => {
  return conversationId !== EmptyConversationId && conversationId !== '';
};

export const buildMessageUuid = (message: Partial<Message | IMessage>) => {
  if ('id' in message && message.id) {
    return message.id;
  }
  return uuid();
};

export const buildMessageListWithUuid = (messages?: Message[]) => {
  return (
    messages?.map((x: Message | IMessage) => ({
      ...omit(x, 'reference'),
      id: buildMessageUuid(x),
    })) ?? []
  );
};

export const sanitizeMessageForRequest = (message: Message | IMessage) => {
  const nextMessage: Record<string, any> = {
    ...message,
  };

  RequestTransientMessageFields.forEach((field) => {
    delete nextMessage[field];
  });

  if (nextMessage.voice) {
    nextMessage.voice = {
      ...nextMessage.voice,
    };
    delete nextMessage.voice.local_url;

    if (Array.isArray(nextMessage.voice.segments)) {
      nextMessage.voice.segments = nextMessage.voice.segments.map(
        (segment: Record<string, any>) => {
          const nextSegment = { ...segment };
          delete nextSegment.object_url;
          return nextSegment;
        },
      );
    }
  }

  return nextMessage;
};

export const sanitizeMessagesForRequest = (
  messages?: Array<Message | IMessage>,
) => {
  return (messages ?? []).map((message) => sanitizeMessageForRequest(message));
};

export const generateConversationId = () => {
  return uuid().replace(/-/g, '');
};

// When rendering each message, add a prefix to the id to ensure uniqueness.
export const buildMessageUuidWithRole = (
  message: Partial<Message | IMessage>,
) => {
  return `${message.role}_${message.id}`;
};

// Preprocess LaTeX equations to be rendered by KaTeX
// ref: https://github.com/remarkjs/react-markdown/issues/785

export const preprocessLaTeX = (content: string) => {
  const blockProcessedContent = content.replace(
    /\\\[([\s\S]*?)\\\]/g,
    (_, equation) => `$$${equation}$$`,
  );
  const inlineProcessedContent = blockProcessedContent.replace(
    /\\\(([\s\S]*?)\\\)/g,
    (_, equation) => `$${equation}$`,
  );
  return inlineProcessedContent;
};

export function removeThinkBlocks(text: string = '') {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .replace(/<\/think>/g, '');
}

export function replaceThinkToSection(text: string = '') {
  const pattern = /<think>([\s\S]*?)<\/think>/g;

  const result = text.replace(pattern, '<section class="think">$1</section>');

  return result;
}

export function setInitialChatVariableEnabledFieldValue(
  field: ChatVariableEnabledField,
) {
  return false;
  return field !== ChatVariableEnabledField.MaxTokensEnabled;
}

const ShowImageFields = ['image', 'table'];

export function showImage(filed?: string) {
  return ShowImageFields.some((x) => x === filed);
}

export function setChatVariableEnabledFieldValuePage() {
  const variableCheckBoxFieldMap = Object.values(
    ChatVariableEnabledField,
  ).reduce<Record<string, boolean>>((pre, cur) => {
    pre[cur] = cur !== ChatVariableEnabledField.MaxTokensEnabled;
    return pre;
  }, {});

  return variableCheckBoxFieldMap;
}

const oldReg = /(#{2}\d+\${2})/g;
export const currentReg = /\[ID:(\d+)\]/g;

// To be compatible with the old index matching mode
export const replaceTextByOldReg = (text: string) => {
  return text?.replace(oldReg, (substring: string) => {
    return `[ID:${substring.slice(2, -2)}]`;
  });
};
