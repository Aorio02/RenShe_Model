import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import api from '@/utils/api';
import { Loader2, Mic, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Input } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

// --- 可视化组件 (保持不变) ---
const VoiceVisualizer = ({ stream, isRecording }: { stream: MediaStream | null; isRecording: boolean }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number>(0);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const startVisualization = () => {
    if (!stream) return;
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
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
    } catch (error: any) {
      console.warn('Visualizer init failed:', error.message);
    }
  };

  const stopVisualization = () => {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioContextRef.current) {
      if (audioContextRef.current.state !== 'closed') audioContextRef.current.close();
      audioContextRef.current = null;
    }
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  useEffect(() => {
    if (isRecording && stream) {
      startVisualization();
    } else {
      stopVisualization();
    }
    return () => stopVisualization();
  }, [isRecording, stream]);

  const draw = () => {
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
      const gradient = ctx.createLinearGradient(0, centerY - barHeight, 0, centerY + barHeight);
      gradient.addColorStop(0, '#3ba05c');
      gradient.addColorStop(1, '#3ba05c');
      ctx.fillStyle = gradient;
      ctx.fillRect(x, centerY - barHeight, barWidth, barHeight * 2);
      x += barWidth + 2;
    }
    animationFrameRef.current = requestAnimationFrame(draw);
  };

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
  value,
}: {
  value: string;
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
        value={value}
        placeholder={isRecording ? "正在录音..." : "点击麦克风开始"}
        suffix={
          <div className="flex justify-end px-1 items-center gap-1 w-20">
            {isRecording && (
              <Button
                variant={'ghost'}
                size="sm"
                className="text-red-500 p-1 border-none hover:bg-red-50 dark:hover:bg-red-900/20"
                onClick={(e) => { e.stopPropagation(); onStop(); }}
              >
                <Square className="fill-current" size={12} />
              </Button>
            )}
            <span className="text-xs text-muted-foreground font-mono">{formatTime(recordingTime)}</span>
          </div>
        }
      />
    </div>
  );
};

export const AudioButton = ({ onOk }: { onOk?: (transcript: string) => void }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  // 内部状态仅用于录音过程中的临时展示，最终结果通过 onOk 交给父组件
  const [popoverOpen, setPopoverOpen] = useState(false);
  
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const currentMimeTypeRef = useRef<string>('audio/webm');

  const cleanup = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.onerror = null;
      mediaRecorderRef.current = null;
    }
  };

  const startRecording = async () => {
    try {
      setRecordingTime(0);
      audioChunksRef.current = [];
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      
      mediaStreamRef.current = stream;

      const possibleTypes = [
        'audio/webm;codecs=opus',
        'audio/webm;codecs=vorbis',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/ogg'
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
      console.log(`[AudioButton] 选用的录音格式：${selectedMimeType}`);

      const options: MediaRecorderOptions = { mimeType: selectedMimeType };
      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        handleRecordingStop();
      };

      recorder.onerror = (event) => {
        console.error('[AudioButton] Recorder 错误:', event);
        toast.error(`录音出错：${(event as any).error?.name || '未知错误'}`);
        setIsRecording(false);
        cleanup();
      };

      recorder.start(250); 
      
      setIsRecording(true);
      setPopoverOpen(true);
      
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => setRecordingTime((prev) => prev + 1), 1000);

    } catch (error: any) {
      console.error('[AudioButton] Start Recording Exception:', error);
      let msg = '无法启动录音';
      if (error.name === 'NotAllowedError') msg = '麦克风权限被拒绝';
      else if (error.name === 'NotFoundError') msg = '未找到麦克风设备';
      else if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') 
        msg = '建议在 HTTPS 或 localhost 环境下使用';
      else if (error.message) msg = error.message;
      
      toast.error(msg);
      setIsRecording(false);
      cleanup();
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      if (mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    } else {
      setIsRecording(false);
      if (intervalRef.current) clearInterval(intervalRef.current);
      cleanup();
    }
  };

  const handleRecordingStop = async () => {
    setIsRecording(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    const actualType = currentMimeTypeRef.current || 'audio/webm';
    const blob = new Blob(audioChunksRef.current, { type: actualType });
    
    // 先清理流，释放麦克风占用
    cleanup();

    if (blob.size === 0 || blob.size < 100) {
       toast.error('录音数据为空，请重试');
       setIsProcessing(false);
       return; 
    }

    console.log(`[AudioButton] 录音完成，大小：${Math.round(blob.size / 1024)} KB`);

    setIsProcessing(true);
    
    try {
      const audioFile = new File([blob], `recording.webm`, { type: actualType });
      const formData = new FormData();
      formData.append('file', audioFile);

      const response = await fetch(api.funasrSequence2txt, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error(`服务器错误：${response.status}`);

      const resJson = await response.json();
      
      const { code, data, message } = resJson;

      if ((code === 200 || code === 0) && data) {
        const text = typeof data === 'string' ? data.trim() : (data.text?.trim() || '');
        
        if (text) {
          // ✅ 核心修改：
          // 1. 调用外部回调，将文本交给父组件 (NextMessageInput)，由父组件填入主输入框
          if (onOk) {
            onOk(text);
          }
          
          toast.success('识别成功，已填入聊天框');
          
          // 2. 延迟关闭弹窗，让用户看到 Toast，但不在内部小框显示结果
          setTimeout(() => {
            setPopoverOpen(false);
          }, 600);
        } else {
          toast.warning('未识别到内容');
          setPopoverOpen(false);
        }
      } else {
        throw new Error(message || '识别结果为空');
      }
    } catch (error: any) {
      console.error('STT Error:', error);
      toast.error('识别失败', { 
        description: error.message || '请稍后重试' 
      });
      setPopoverOpen(false);
    } finally {
      setIsProcessing(false);
    }
  };

  useEffect(() => {
    return () => cleanup();
  }, []);

  return (
    <div className="relative w-6 h-6 flex items-center justify-center">
      {isRecording && (
        <div className="absolute inset-0 rounded-full border-2 border-state-success-500 animate-ping opacity-75"></div>
      )}
      
      {isRecording && (
        <div className="absolute inset-0 w-full h-6 rounded-md overflow-hidden flex items-center justify-center p-1 z-10 pointer-events-none">
           <VoiceVisualizer stream={mediaStreamRef.current} isRecording={isRecording} />
        </div>
      )}

      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (isProcessing) return;
              if (isRecording) stopRecording();
              else startRecording();
            }}
            className={cn(
              "w-6 h-6 p-0 rounded-md border-none transition-all duration-200",
              isRecording 
                ? "bg-state-success-100 text-state-success hover:bg-state-success-200" 
                : "hover:bg-muted text-muted-foreground hover:text-foreground",
              isProcessing && "cursor-not-allowed opacity-70"
            )}
            disabled={isProcessing}
            title={isRecording ? "停止录音" : "语音输入"}
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
            value={isRecording ? "正在录音..." : ""} 
            onStop={stopRecording}
            recordingTime={recordingTime}
          />
          {isProcessing && <div className="text-xs text-center text-muted-foreground mt-1">正在识别...</div>}
        </PopoverContent>
      </Popover>
    </div>
  );
};