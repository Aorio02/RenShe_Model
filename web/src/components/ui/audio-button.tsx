import { AudioRecorder, useAudioRecorder } from 'react-audio-voice-recorder';
import { Button } from '@/components/ui/button';
import { Authorization } from '@/constants/authorization';
import { cn } from '@/lib/utils';
import api from '@/utils/api';
import { getAuthorization } from '@/utils/authorization-util';
import { Loader2, Mic, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Input } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
const VoiceVisualizer = ({ isRecording }: { isRecording: boolean }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);

  const startVisualization = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const audioContext = new AudioContextClass();
      audioContextRef.current = audioContext;
      const analyser = audioContext.createAnalyser();
      analyserRef.current = analyser;
      analyser.fftSize = 32;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      draw();
    } catch (error: any) {
      console.warn('Visualizer init failed:', error.message);
    }
  };

  const stopVisualization = () => {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
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
    if (isRecording) startVisualization();
    else stopVisualization();
    return () => stopVisualization();
  }, [isRecording]);

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
      <div className="absolute w-full h-6 translate-y-1 opacity-80 pointer-events-none">
        <VoiceVisualizer isRecording={isRecording} />
      </div>
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
  const [transcript, setTranscript] = useState('');
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const recorderControls = useAudioRecorder();
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (recorderControls && !isReady) {
      const timer = setTimeout(() => setIsReady(true), 100);
      return () => clearTimeout(timer);
    }
  }, [recorderControls, isReady]);

  const handleRecordingComplete = async (blob: Blob) => {
    setIsRecording(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    try {
      const now = new Date();
      const timeStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileName = `recording_${timeStr}.webm`;
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      toast.success('录音已保存', { description: `文件：${fileName}` });
    } catch (err) {
      console.error('Save file error:', err);
      toast.error('保存文件失败');
    }

    setIsProcessing(true);
    
    try {
      const audioFile = new File([blob], 'recording.webm', { type: blob.type || 'audio/webm' });
      const formData = new FormData();
      formData.append('file', audioFile);
      formData.append('stream', 'false');
      
      // 可选：如果后端需要 model 参数，可以在这里加上
      // formData.append('model', 'default'); 

      const response = await fetch(api.sequence2txt, {
        method: 'POST',
        headers: { [Authorization]: getAuthorization() },
        body: formData,
      });

      if (!response.ok) throw new Error(`服务器错误: ${response.status}`);

      const resJson = await response.json();
      const { data, code, message } = resJson;

      if (code === 0 && data?.text) {
        const text = data.text.trim();
        setTranscript(text);
        if (text) {
          toast.success('识别成功');
          onOk?.(text);
          setTimeout(() => {
            setPopoverOpen(false);
            setTranscript('');
          }, 500);
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
        description: error.message || '请稍后重试 (录音文件已保存)' 
      });
      setPopoverOpen(false);
    } finally {
      setIsProcessing(false);
    }
  };

  const startRecording = async () => {
    if (!isReady) {
      toast.warning('音频模块初始化中...', { description: '请稍等 1 秒再试' });
      return;
    }
    try {
      setTranscript('');
      setRecordingTime(0);
      recorderControls.startRecording();
      setIsRecording(true);
      setPopoverOpen(true);
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => setRecordingTime((prev) => prev + 1), 1000);
    } catch (error: any) {
      console.error('Start Recording Exception:', error);
      if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        toast.error('不安全的环境', { description: 'Chrome 要求麦克风必须在 HTTPS 或 localhost 下使用。' });
      } else {
        toast.error('无法启动录音', { description: error.message });
      }
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    try { recorderControls.stopRecording(); } catch (e) { console.error(e); }
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  };

  useEffect(() => {
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  return (
    <div className="relative w-6 h-6 flex items-center justify-center">
      {isRecording && (
        <div className="absolute inset-0 rounded-full border-2 border-state-success-500 animate-ping opacity-75"></div>
      )}
      
      {isRecording && (
        <div className="absolute inset-0 w-full h-6 rounded-md overflow-hidden flex items-center justify-center p-1 z-10 pointer-events-none">
           <VoiceVisualizer isRecording={isRecording} />
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
            disabled={isProcessing || !isReady}
            title={!isReady ? "初始化中..." : (isRecording ? "停止录音" : "语音输入")}
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
            value={transcript}
            onStop={stopRecording}
            recordingTime={recordingTime}
          />
          {isProcessing && <div className="text-xs text-center text-muted-foreground mt-1">正在识别...</div>}
          {!isReady && <div className="text-xs text-center text-yellow-600 mt-1">正在加载音频模块...</div>}
        </PopoverContent>
      </Popover>

      <div style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0, overflow: 'hidden' }}>
        <AudioRecorder
          onRecordingComplete={handleRecordingComplete}
          recorderControls={recorderControls}
          audioTrackConstraints={{ noiseSuppression: true, echoCancellation: true }}
          mediaRecorderOptions={{ mimeType: 'audio/webm' }}
        />
      </div>
    </div>
  );
};