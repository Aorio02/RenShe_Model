import { useEffect, useState } from 'react';
import { Book, Bot, FileText, Settings } from 'lucide-react';
import { Link } from 'react-router';
import { rsaPsw } from '@/utils';
import { useLogin } from '@/hooks/use-login-request';
import { useMutation } from '@tanstack/react-query';

const Dashboard = () => {
  const [hasAttemptedAutoLogin, setHasAttemptedAutoLogin] = useState(false);
  const [loginStatus, setLoginStatus] = useState<'idle' | 'checking' | 'success' | 'failed'>('idle');

  const { login: userLogin, loading: isLoggingIn } = useLogin();

  const autoLoginMutation = useMutation({
    mutationKey: ['autoUserLogin'],
    mutationFn: async () => {
      const account = '1223086775@qq.com';
      const password = 'RenShe666';
      const rsaPassWord = rsaPsw(password) as string;

      const code = await userLogin({
        email: account,
        password: rsaPassWord,
      });

      if (code !== 0) {
        throw new Error(`Login failed with code: ${code}`);
      }

      return { code };
    },
    onSuccess: () => {
      setLoginStatus('success');
    },
    onError: () => {
      setLoginStatus('failed');
    },
    retry: false,
  });

  useEffect(() => {
    if (!hasAttemptedAutoLogin) {
      setHasAttemptedAutoLogin(true);
      setLoginStatus('checking');

      Promise.resolve().then(() => {
        autoLoginMutation.mutate();
      });
    }
  }, [hasAttemptedAutoLogin]);

  if (loginStatus === 'checking' || autoLoginMutation.isPending || isLoggingIn) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-[#06336a] text-white">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-white mx-auto mb-6"></div>
          <p className="text-xl font-bold tracking-widest animate-pulse">正在加载...</p>
          <p className="text-sm opacity-60 mt-4">系统初始化中</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full relative overflow-hidden bg-gradient-to-br from-[#0c5baf] via-[#09478f] to-[#06336a] text-white font-sans">
      <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full bg-[#1878d6] opacity-30 blur-[120px]"></div>
      <div className="absolute bottom-[0%] right-[0%] w-[800px] h-[500px] rounded-full bg-[#1a85eb] opacity-30 blur-[150px]"></div>

      <div className="w-full h-24 flex items-center justify-center relative px-8 z-20">
        <div className="bg-[#dcdcdc] text-black font-semibold text-2xl tracking-widest px-24 py-3 rounded-xl shadow-lg border border-white/20">
          人社智能问答系统
        </div>
        <div className="absolute right-8">
          <Link
            to="/user-setting/model"
            className="flex items-center gap-2 bg-[#dcdcdc] text-black hover:bg-gray-300 transition-colors px-6 py-3 rounded-full shadow-lg font-medium tracking-wide"
          >
            <Settings size={18} />
            模型配置
          </Link>
        </div>
      </div>

      <div className="relative z-10 w-full h-[calc(100vh-6rem)] flex flex-col justify-center px-16 lg:px-24">
        <div className="absolute top-0 xl:top-4 left-16 lg:left-24 max-w-xl pr-4">
          <h1 className="text-[42px] font-bold tracking-wider mb-6 text-white drop-shadow-md">
            欢迎访问人社服务平台
          </h1>
          <p className="text-[#a0cbfc] text-lg tracking-widest mb-10 flex gap-4">
            <span>一体式人社服务</span><span>方便</span><span>快捷</span><span>安全</span>
          </p>

          <ul className="space-y-4 text-xl tracking-wider text-white">
            <li><span className="flex items-center gap-3 hover:text-blue-300 transition-colors cursor-pointer w-fit"><span className="w-2.5 h-2.5 bg-white rounded-full"></span>社保服务</span></li>
            <li><span className="flex items-center gap-3 hover:text-blue-300 transition-colors cursor-pointer w-fit"><span className="w-2.5 h-2.5 bg-white rounded-full"></span>医保服务</span></li>
            <li><span className="flex items-center gap-3 hover:text-blue-300 transition-colors cursor-pointer w-fit"><span className="w-2.5 h-2.5 bg-white rounded-full"></span>就业服务</span></li>
          </ul>
        </div>

        <div className="absolute bottom-32 left-0 w-full flex gap-8 lg:gap-12 justify-center px-10">
          <Link to="/datasets" className="w-[380px] h-[180px] group bg-white/20 backdrop-blur-xl border border-white/30 rounded-2xl shadow-xl flex items-center justify-center px-8 gap-6 hover:bg-white/30 hover:scale-105 transition-all duration-300 cursor-pointer overflow-hidden relative">
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-[150%] group-hover:translate-x-[150%] transition-transform duration-700"></div>
            <div className="w-16 h-16 bg-gradient-to-b from-yellow-300 to-amber-500 rounded-xl flex items-center justify-center shadow-lg shrink-0"><Book size={32} className="text-white" /></div>
            <span className="text-[24px] font-medium tracking-wide">人社知识库管理</span>
          </Link>
          <Link to="/next-chats" className="w-[380px] h-[180px] group bg-white/20 backdrop-blur-xl border border-white/30 rounded-2xl shadow-xl flex items-center justify-center px-8 gap-6 hover:bg-white/30 hover:scale-105 transition-all duration-300 cursor-pointer overflow-hidden relative">
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-[150%] group-hover:translate-x-[150%] transition-transform duration-700"></div>
            <div className="w-16 h-16 bg-gradient-to-b from-blue-300 to-blue-500 rounded-xl flex items-center justify-center shadow-lg shrink-0"><Bot size={32} className="text-white" /></div>
            <span className="text-[24px] font-medium tracking-wide">人社智能问答</span>
          </Link>
          <Link to="/files" className="w-[380px] h-[180px] group bg-white/20 backdrop-blur-xl border border-white/30 rounded-2xl shadow-xl flex items-center justify-center px-8 gap-6 hover:bg-white/30 hover:scale-105 transition-all duration-300 cursor-pointer overflow-hidden relative">
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-[150%] group-hover:translate-x-[150%] transition-transform duration-700"></div>
            <div className="w-16 h-16 bg-gradient-to-b from-green-400 to-green-600 rounded-xl flex items-center justify-center shadow-lg shrink-0"><FileText size={32} className="text-white" /></div>
            <span className="text-[24px] font-medium tracking-wide">人社文件管理</span>
          </Link>
        </div>
      </div>

      <div className="absolute bottom-[-150px] left-1/2 transform -translate-x-1/2 w-[1200px] h-[300px] rounded-[100%] border-[2px] border-white/10 flex items-center justify-center">
        <div className="w-[900px] h-[200px] rounded-[100%] border-[2px] border-white/20 bg-blue-500/10 backdrop-blur-sm"></div>
      </div>
    </div>
  );
};

export default Dashboard;