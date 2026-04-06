import { Button } from '@/components/ui/button';
import { IVoiceMeta } from '@/interfaces/database/chat';
import { cn } from '@/lib/utils';
import api from '@/utils/api';
import { getAuthorization } from '@/utils/authorization-util';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface VoiceBubbleProps {
  assistantVoiceAutoPlayNonce?: number;
  onAssistantVoiceAutoPlayConsumed?: (messageId: string, nonce?: number) => void;
  conversationId?: string;
  messageId: string;
  role: 'user' | 'assistant';
  loading?: boolean;
  voice?: IVoiceMeta;
  onRetry?: (messageId: string) => void;
}

export function VoiceBubble({
  assistantVoiceAutoPlayNonce,
  onAssistantVoiceAutoPlayConsumed,
  conversationId,
  messageId,
  role,
  loading = false,
  voice,
  onRetry,
}: VoiceBubbleProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cachedUrlRef = useRef<Map<string, string>>(new Map());
  const nextSegmentIndexRef = useRef(0);
  const playbackModeRef = useRef<'single' | 'segments'>('segments');
  const autoPlayedNonceRef = useRef<number | undefined>(undefined);
  const [isPlaying, setIsPlaying] = useState(false);

  const segments = useMemo(() => voice?.segments ?? [], [voice?.segments]);
  const hasSingleSource = Boolean(voice?.local_url || voice?.file_id);

  const revokeCachedUrls = useCallback(() => {
    cachedUrlRef.current.forEach((url) => {
      if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    });
    cachedUrlRef.current.clear();
  }, []);

  const pausePlayback = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const fetchRemoteUrl = useCallback(
    async (seq?: number) => {
      if (!conversationId) {
        throw new Error('conversationId is required for voice playback');
      }
      const cacheKey = `${messageId}:${typeof seq === 'number' ? seq : 'single'}`;
      const cachedUrl = cachedUrlRef.current.get(cacheKey);
      if (cachedUrl) {
        return cachedUrl;
      }
      const response = await fetch(
        api.voiceFile({
          conversationId,
          messageId,
          seq,
          role,
        }),
        {
          headers: {
            Authorization: getAuthorization(),
          },
        },
      );
      if (!response.ok) {
        throw new Error(`voice fetch failed: ${response.status}`);
      }
      const contentType =
        response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() ||
        '';
      if (contentType && !contentType.startsWith('audio/')) {
        throw new Error(`voice fetch returned ${contentType}`);
      }
      const blob = await response.blob();
      if (!blob.size) {
        throw new Error('voice file is empty');
      }
      const objectUrl = URL.createObjectURL(blob);
      cachedUrlRef.current.set(cacheKey, objectUrl);
      return objectUrl;
    },
    [conversationId, messageId, role],
  );

  const playSingle = useCallback(async () => {
    if (!voice) return;
    const audio = audioRef.current;
    if (!audio) return;

    playbackModeRef.current = 'single';
    const sourceUrl = voice.file_id
      ? await fetchRemoteUrl(undefined)
      : voice.local_url || (await fetchRemoteUrl(undefined));
    audio.pause();
    audio.currentTime = 0;
    audio.src = sourceUrl;
    audio.load();
    await audio.play();
  }, [fetchRemoteUrl, voice]);

  const playSegment = useCallback(
    async (index: number) => {
      const audio = audioRef.current;
      if (!audio || !segments[index]) return;

      const segment = segments[index];
      const sourceUrl = segment.file_id
        ? await fetchRemoteUrl(segment.seq)
        : segment.object_url || (await fetchRemoteUrl(segment.seq));
      playbackModeRef.current = 'segments';
      audio.pause();
      audio.currentTime = 0;
      audio.src = sourceUrl;
      audio.load();
      nextSegmentIndexRef.current = index;
      await audio.play();
    },
    [fetchRemoteUrl, segments],
  );

  useEffect(() => {
    const audio = audioRef.current;

    return () => {
      pausePlayback();
      if (audio) {
        audio.removeAttribute('src');
        audio.load();
      }
      revokeCachedUrls();
    };
  }, [pausePlayback, revokeCachedUrls]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onStartPlaying = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onError = () => setIsPlaying(false);
    const onEnded = () => {
      if (playbackModeRef.current !== 'segments') {
        setIsPlaying(false);
        return;
      }
      const nextIndex = nextSegmentIndexRef.current + 1;
      nextSegmentIndexRef.current = nextIndex;
      if (nextIndex < segments.length) {
        void playSegment(nextIndex);
        return;
      }
      setIsPlaying(false);
    };

    audio.addEventListener('play', onStartPlaying);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('error', onError);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('play', onStartPlaying);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('ended', onEnded);
    };
  }, [playSegment, segments.length, voice?.kind]);

  useEffect(() => {
    if (
      role !== 'assistant' ||
      !assistantVoiceAutoPlayNonce ||
      autoPlayedNonceRef.current === assistantVoiceAutoPlayNonce ||
      !voice ||
      isPlaying
    ) {
      return;
    }

    const canAutoPlaySegments =
      voice.kind === 'segments' && segments.length > 0;
    const canAutoPlaySingle =
      voice.kind === 'single' && Boolean(voice.file_id || voice.local_url);

    if (!canAutoPlaySegments && !canAutoPlaySingle) {
      return;
    }

    autoPlayedNonceRef.current = assistantVoiceAutoPlayNonce;
    onAssistantVoiceAutoPlayConsumed?.(
      messageId,
      assistantVoiceAutoPlayNonce,
    );

    const startPlayback = async () => {
      if (canAutoPlaySegments) {
        nextSegmentIndexRef.current = 0;
        await playSegment(0);
        return;
      }
      await playSingle();
    };

    void startPlayback().catch((error) => {
      setIsPlaying(false);
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        return;
      }
      console.warn('assistant voice autoplay failed', error);
    });
  }, [
    assistantVoiceAutoPlayNonce,
    isPlaying,
    messageId,
    onAssistantVoiceAutoPlayConsumed,
    playSegment,
    playSingle,
    role,
    segments.length,
    voice,
  ]);

  const handleTogglePlayback = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !voice) return;

    try {
      if (isPlaying) {
        pausePlayback();
        return;
      }

      if (voice.kind === 'single' || (hasSingleSource && !loading)) {
        await playSingle();
        return;
      }

      nextSegmentIndexRef.current = 0;
      await playSegment(0);
    } catch {
      setIsPlaying(false);
      toast.error('语音播放失败，请稍后重试');
    }
  }, [
    hasSingleSource,
    isPlaying,
    loading,
    pausePlayback,
    playSegment,
    playSingle,
    voice,
  ]);

  if (!voice) {
    return null;
  }

  const isFailed = voice.status === 'failed';
  const statusText =
    voice.status === 'transcribing'
      ? '转写中...'
      : voice.status === 'streaming'
        ? '语音生成中...'
        : voice.status === 'partial'
          ? '部分语音可播放'
          : isFailed && role === 'assistant'
            ? '语音回复失败'
          : isFailed
              ? '转写失败'
              : '';

  const durationSeconds = Math.round((voice.duration_ms ?? 0) / 1000);
  const canPlay =
    hasSingleSource ||
    (voice.kind === 'segments' && segments.length > 0);

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-2xl px-3 py-2 max-w-[280px]',
        role === 'user'
          ? 'bg-white/30 ml-auto'
          : 'bg-muted/60',
      )}
    >
      <audio ref={audioRef} preload="none" />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-8 rounded-full"
        onClick={() => void handleTogglePlayback()}
        disabled={!canPlay}
      >
        {isPlaying ? <Pause size={16} /> : <Play size={16} />}
      </Button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <div className="h-2 flex-1 rounded-full bg-foreground/10 overflow-hidden">
            <div
              className="h-full rounded-full bg-foreground/40"
              style={{
                width:
                  voice.kind === 'segments'
                    ? `${Math.min(100, Math.max(18, segments.length * 18))}%`
                    : `${Math.min(100, Math.max(28, durationSeconds * 8))}%`,
              }}
            />
          </div>
          {voice.kind === 'single' && durationSeconds > 0 && (
            <span className="text-xs text-muted-foreground">
              {durationSeconds}
              &quot;
            </span>
          )}
        </div>
        {statusText && (
          <div className="mt-1 text-xs text-muted-foreground flex items-center gap-2">
            <span>{statusText}</span>
            {isFailed && role === 'user' && onRetry && (
              <button
                type="button"
                className="inline-flex items-center gap-1 hover:underline"
                onClick={() => onRetry(messageId)}
              >
                <RotateCcw size={12} />
                重试
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
