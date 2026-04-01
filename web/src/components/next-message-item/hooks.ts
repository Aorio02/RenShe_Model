// import { useDeleteMessage, useFeedback } from '@/hooks/chat-hooks';
import { useSetModalState } from '@/hooks/common-hooks';
import { IRemoveMessageById, useSpeechWithSse } from '@/hooks/logic-hooks';
import { useDeleteMessage, useFeedback } from '@/hooks/use-chat-request';
import { IFeedbackRequestBody } from '@/interfaces/request/chat';
import { hexStringToUint8Array } from '@/utils/common-util';
import { message } from 'antd';
import { SpeechPlayer } from 'openai-speech-stream-player';
import { useCallback, useEffect, useRef, useState } from 'react';

const detectAudioMimeType = (units: Uint8Array) => {
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

export const useSendFeedback = (messageId: string) => {
  const { visible, hideModal, showModal } = useSetModalState();
  const { feedback, loading } = useFeedback();

  const onFeedbackOk = useCallback(
    async (params: IFeedbackRequestBody) => {
      const ret = await feedback({
        ...params,
        messageId: messageId,
      });

      if (ret === 0) {
        hideModal();
      }
    },
    [feedback, hideModal, messageId],
  );

  return {
    loading,
    onFeedbackOk,
    visible,
    hideModal,
    showModal,
  };
};

export const useRemoveMessage = (
  messageId: string,
  removeMessageById?: IRemoveMessageById['removeMessageById'],
) => {
  const { deleteMessage, loading } = useDeleteMessage();

  const onRemoveMessage = useCallback(async () => {
    if (messageId) {
      const code = await deleteMessage(messageId);
      if (code === 0) {
        removeMessageById?.(messageId);
      }
    }
  }, [deleteMessage, messageId, removeMessageById]);

  return { onRemoveMessage, loading };
};

export const useSpeech = (content: string, audioBinary?: string) => {
  const ref = useRef<HTMLAudioElement>(null);
  const { read } = useSpeechWithSse();
  const player = useRef<SpeechPlayer>();
  const objectUrlRef = useRef<string | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  const revokeObjectUrl = useCallback(() => {
    if (objectUrlRef.current?.startsWith('blob:')) {
      URL.revokeObjectURL(objectUrlRef.current);
    }
    objectUrlRef.current = null;
  }, []);

  const initialize = useCallback(async () => {
    if (!ref.current) {
      return;
    }
    player.current = new SpeechPlayer({
      audio: ref.current!,
      onPlaying: () => {
        setIsPlaying(true);
      },
      onPause: () => {
        setIsPlaying(false);
      },
      onChunkEnd: () => {},
      mimeType: MediaSource.isTypeSupported('audio/mpeg')
        ? 'audio/mpeg'
        : 'audio/mp4; codecs="mp4a.40.2"', // https://stackoverflow.com/questions/64079424/cannot-replay-mp3-in-firefox-using-mediasource-even-though-it-works-in-chrome
    });
    await player.current.init();
  }, []);

  const pause = useCallback(() => {
    player.current?.pause();
    ref.current?.pause();
  }, []);

  const playBlob = useCallback(
    async (blob: Blob) => {
      const audio = ref.current;
      if (!audio) {
        return;
      }

      revokeObjectUrl();
      const objectUrl = URL.createObjectURL(blob);
      objectUrlRef.current = objectUrl;

      audio.pause();
      audio.currentTime = 0;
      audio.src = objectUrl;
      audio.load();
      await audio.play();
    },
    [revokeObjectUrl],
  );

  const speech = useCallback(async () => {
    const response = await read({ text: content });
    if (!response) {
      return;
    }

    if (!response.ok) {
      throw new Error(`tts request failed: ${response.status}`);
    }

    const contentType =
      response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() ||
      '';

    if (
      player.current &&
      (contentType === 'audio/mpeg' ||
        contentType === 'audio/mp3' ||
        contentType === 'audio/mp4')
    ) {
      await player.current?.feedWithResponse(response);
      return;
    }

    if (contentType.startsWith('audio/')) {
      const buffer = await response.arrayBuffer();
      const blob = new Blob([buffer], {
        type: contentType || 'audio/wav',
      });
      await playBlob(blob);
      return;
    }

    throw new Error(`unexpected tts content-type: ${contentType || 'unknown'}`);
  }, [content, playBlob, read]);

  const playEmbeddedAudio = useCallback(async () => {
    if (!audioBinary) {
      return false;
    }

    const units = hexStringToUint8Array(audioBinary);
    if (!units?.length) {
      return false;
    }

    const blob = new Blob([units], {
      type: detectAudioMimeType(units),
    });
    await playBlob(blob);
    return true;
  }, [audioBinary, playBlob]);

  const handleRead = useCallback(async () => {
    if (isPlaying) {
      setIsPlaying(false);
      pause();
    } else {
      try {
        const hasEmbeddedAudio = await playEmbeddedAudio();
        if (!hasEmbeddedAudio) {
          await speech();
        }
      } catch (error) {
        setIsPlaying(false);
        message.error(
          error instanceof Error ? error.message : '语音朗读失败',
        );
      }
    }
  }, [setIsPlaying, playEmbeddedAudio, speech, isPlaying, pause]);

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    const audio = ref.current;
    if (!audio) {
      return;
    }

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => setIsPlaying(false);

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
    };
  }, []);

  useEffect(() => {
    return () => {
      revokeObjectUrl();
    };
  }, [revokeObjectUrl]);

  return { ref, handleRead, isPlaying };
};
