import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Loader2, Mic, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Input } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

const VoiceVisualizer = ({
  stream,
  isRecording,
}: {
  stream: MediaStream | null;
  isRecording: boolean;
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number>(0);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const analyser = analyserRef.current;
    if (!analyser) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const centerY = height / 2;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.clearRect(0, 0, width, height);
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    const barWidth = (width / bufferLength) * 1.5;
    let x = 0;

    for (let i = 0; i < bufferLength; i = i + 2) {
      const barHeight = (dataArray[i] / 255) * centerY;
      ctx.fillStyle = '#3ba05c';
      ctx.fillRect(x, centerY - barHeight, barWidth, barHeight * 2);
      x += barWidth + 2;
    }
    animationFrameRef.current = requestAnimationFrame(draw);
  }, []);

  const stopVisualization = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioContextRef.current) {
      if (audioContextRef.current.state !== 'closed') {
        void audioContextRef.current.close();
      }
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  const startVisualization = useCallback(() => {
    if (!stream) return;
    stopVisualization();
    try {
      const AudioContextClass =
        window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      const audioContext = new AudioContextClass();
      audioContextRef.current = audioContext;

      const analyser = audioContext.createAnalyser();
      analyserRef.current = analyser;
      analyser.fftSize = 32;

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;
      source.connect(analyser);

      draw();
    } catch {
      stopVisualization();
    }
  }, [draw, stopVisualization, stream]);

  useEffect(() => {
    if (isRecording && stream) {
      startVisualization();
    } else {
      stopVisualization();
    }
    return () => stopVisualization();
  }, [isRecording, startVisualization, stopVisualization, stream]);

  return (
    <div className="w-full h-6 bg-transparent flex items-center justify-center overflow-hidden">
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  );
};

const VoiceInputBox = ({
  isRecording,
  onStop,
  recordingTime,
}: {
  isRecording: boolean;
  onStop: () => void;
  recordingTime: number;
}) => {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="w-full relative">
      <Input
        rootClassName="w-full relative z-10"
        className="flex-1 bg-white/90 dark:bg-black/90 backdrop-blur-sm"
        readOnly
        value=""
        placeholder={isRecording ? '正在录音...' : '点击麦克风开始'}
        suffix={
          <div className="flex justify-end px-1 items-center gap-1 w-20">
            {isRecording && (
              <Button
                type="button"
                variant={'ghost'}
                size="sm"
                className="text-red-500 p-1 border-none hover:bg-red-50 dark:hover:bg-red-900/20"
                onClick={(e) => {
                  e.stopPropagation();
                  onStop();
                }}
              >
                <Square className="fill-current" size={12} />
              </Button>
            )}
            <span className="text-xs text-muted-foreground font-mono">
              {formatTime(recordingTime)}
            </span>
          </div>
        }
      />
    </div>
  );
};

export interface RecordedVoicePayload {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  waveform: number[];
}

export const AudioButton = ({
  onSubmit,
}: {
  onSubmit?: (payload: RecordedVoicePayload) => void;
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [popoverOpen, setPopoverOpen] = useState(false);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const intervalRef = useRef<number | null>(null);
  const currentMimeTypeRef = useRef<string>('audio/webm');
  const recordingStartedAtRef = useRef<number>(0);

  const cleanup = useCallback(() => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.onerror = null;
      mediaRecorderRef.current = null;
    }
  }, []);

  const handleRecordingStop = useCallback(async () => {
    setIsRecording(false);

    const durationMs = Math.max(
      0,
      recordingStartedAtRef.current
        ? Date.now() - recordingStartedAtRef.current
        : recordingTime * 1000,
    );
    const actualType = currentMimeTypeRef.current || 'audio/webm';
    const blob = new Blob(audioChunksRef.current, { type: actualType });
    cleanup();

    if (blob.size < 100) {
      toast.error('录音数据为空，请重试');
      setIsProcessing(false);
      setPopoverOpen(false);
      return;
    }

    setIsProcessing(true);
    try {
      onSubmit?.({
        blob,
        mimeType: actualType,
        durationMs,
        waveform: [],
      });
      setPopoverOpen(false);
      setRecordingTime(0);
    } finally {
      setIsProcessing(false);
      recordingStartedAtRef.current = 0;
    }
  }, [cleanup, onSubmit, recordingTime]);

  const startRecording = useCallback(async () => {
    try {
      if (typeof MediaRecorder === 'undefined') {
        throw new Error('当前浏览器不支持录音');
      }

      setRecordingTime(0);
      audioChunksRef.current = [];
      recordingStartedAtRef.current = Date.now();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const possibleTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/ogg',
      ];

      let selectedMimeType = '';
      for (const type of possibleTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
          selectedMimeType = type;
          break;
        }
      }

      if (!selectedMimeType) {
        throw new Error('当前浏览器不支持任何已知的音频录制格式');
      }

      currentMimeTypeRef.current = selectedMimeType;

      const recorder = new MediaRecorder(stream, { mimeType: selectedMimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        void handleRecordingStop();
      };

      recorder.onerror = (event) => {
        toast.error(`录音出错：${(event as any).error?.name || '未知错误'}`);
        setIsRecording(false);
        cleanup();
      };

      recorder.start(250);
      setIsRecording(true);
      setPopoverOpen(true);

      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
      }
      intervalRef.current = window.setInterval(() => {
        if (!recordingStartedAtRef.current) return;
        setRecordingTime(
          Math.floor((Date.now() - recordingStartedAtRef.current) / 1000),
        );
      }, 250);
    } catch (error: any) {
      let msg = '无法启动录音';
      if (error.name === 'NotAllowedError') msg = '麦克风权限被拒绝';
      else if (error.name === 'NotFoundError') msg = '未找到麦克风设备';
      else if (
        location.protocol !== 'https:' &&
        location.hostname !== 'localhost' &&
        location.hostname !== '127.0.0.1'
      ) {
        msg = '建议在 HTTPS 或 localhost 环境下使用';
      } else if (error.message) {
        msg = error.message;
      }

      toast.error(msg);
      setIsRecording(false);
      recordingStartedAtRef.current = 0;
      cleanup();
    }
  }, [cleanup, handleRecordingStop]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      if (mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    } else {
      setIsRecording(false);
      cleanup();
      recordingStartedAtRef.current = 0;
    }
  }, [cleanup, isRecording]);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return (
    <div className="relative w-6 h-6 flex items-center justify-center">
      {isRecording && (
        <div className="absolute inset-0 rounded-full border-2 border-state-success-500 animate-ping opacity-75" />
      )}

      {isRecording && (
        <div className="absolute inset-0 w-full h-6 rounded-md overflow-hidden flex items-center justify-center p-1 z-10 pointer-events-none">
          <VoiceVisualizer
            stream={mediaStreamRef.current}
            isRecording={isRecording}
          />
        </div>
      )}

      <Popover
        open={popoverOpen}
        onOpenChange={(open) => {
          if (!open && (isRecording || isProcessing)) {
            return;
          }
          setPopoverOpen(open);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (isProcessing) return;
              if (isRecording) stopRecording();
              else void startRecording();
            }}
            className={cn(
              'w-6 h-6 p-0 rounded-md border-none transition-all duration-200',
              isRecording
                ? 'bg-state-success-100 text-state-success hover:bg-state-success-200'
                : 'hover:bg-muted text-muted-foreground hover:text-foreground',
              isProcessing && 'cursor-not-allowed opacity-70',
            )}
            disabled={isProcessing}
            title={isRecording ? '停止录音' : '语音输入'}
          >
            {isProcessing ? (
              <Loader2 size={16} className="animate-spin" />
            ) : isRecording ? (
              <Square size={14} className="fill-current opacity-80" />
            ) : (
              <Mic size={16} />
            )}
          </Button>
        </PopoverTrigger>

        <PopoverContent
          align="center"
          side="top"
          sideOffset={10}
          className="w-64 p-2 shadow-lg border-none bg-popover/95 backdrop-blur"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <VoiceInputBox
            isRecording={isRecording}
            onStop={stopRecording}
            recordingTime={recordingTime}
          />
          {isProcessing && (
            <div className="text-xs text-center text-muted-foreground mt-1">
              正在准备发送...
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
};
