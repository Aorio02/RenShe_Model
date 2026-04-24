import backImg from '@/assets/back.png';
import logoImg from '@/assets/logo.png';
import { useSystemRoleAccess } from '@/hooks/use-system-role-access';
import {
  Book,
  Bot,
  FileText,
  Settings,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';

const Dashboard = () => {
  const navigate = useNavigate();
  const [hasCheckedAuth, setHasCheckedAuth] = useState(false);
  const {
    loading,
    showDashboardDataset,
    showDashboardFiles,
    showDashboardModelShortcut,
  } = useSystemRoleAccess();

  useEffect(() => {
    const token = localStorage.getItem('Token');

    if (!token) {
      navigate('/login', { replace: true });
      return;
    }

    setHasCheckedAuth(true);
  }, [navigate]);

  if (!hasCheckedAuth || loading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-[#06336a] text-white">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-white mx-auto mb-6"></div>
          <p className="text-xl font-bold tracking-widest animate-pulse">
            正在校验登录状态...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full relative overflow-hidden bg-gradient-to-br from-[#4A9FE0] via-[#2979C2] to-[#1565C0] text-white font-sans">
      <div
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 0,
          backgroundImage: `url(${backImg})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          opacity: 0.15,
        }}
      />

      <div className="w-full h-24 flex items-center justify-center relative px-8 z-20">
        <div className="bg-[#f0f9ff]/80 backdrop-blur-md text-[#0284c7] font-semibold text-2xl tracking-widest px-12 py-3 rounded-xl shadow-lg border border-white/30 flex items-center gap-4">
          <img src={logoImg} alt="logo" className="h-10 w-auto" />
          人社智能问答系统
        </div>

        {showDashboardModelShortcut && (
          <div className="absolute right-8">
            <Link
              to="/user-setting/model"
              className="flex items-center gap-2 bg-[#dcdcdc] text-black hover:bg-gray-300 transition-colors px-6 py-3 rounded-full shadow-lg font-medium tracking-wide"
            >
              <Settings size={18} />
              模型配置
            </Link>
          </div>
        )}
      </div>

      <div className="relative z-10 w-full h-[calc(100vh-6rem)] flex flex-col justify-center px-16 lg:px-24">
        <div className="absolute top-0 xl:top-4 left-16 lg:left-24 max-w-xl pr-4">
          <h1 className="text-[42px] font-bold tracking-wider mb-6 text-white drop-shadow-md">
            欢迎访问人社服务平台
          </h1>
          <p className="text-[#a0cbfc] text-lg tracking-widest mb-10 flex gap-4">
            <span>一体式人社服务</span>
            <span>方便</span>
            <span>快捷</span>
            <span>安全</span>
          </p>
          <ul className="space-y-4 text-xl tracking-wider text-white">
            <li>
              <span className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 bg-white rounded-full"></span>
                社保服务
              </span>
            </li>
            <li>
              <span className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 bg-white rounded-full"></span>
                医保服务
              </span>
            </li>
            <li>
              <span className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 bg-white rounded-full"></span>
                就业服务
              </span>
            </li>
          </ul>
        </div>

        <div className="absolute bottom-32 left-0 w-full flex gap-8 lg:gap-12 justify-center px-10">
          {showDashboardDataset && (
            <Link
              to="/datasets"
              className="w-[380px] h-[180px] group bg-white/20 backdrop-blur-xl border border-white/30 rounded-2xl shadow-xl flex items-center justify-center px-8 gap-6 hover:bg-white/30 hover:scale-105 transition-all"
            >
              <div className="w-16 h-16 bg-gradient-to-b from-yellow-300 to-amber-500 rounded-xl flex items-center justify-center">
                <Book size={32} className="text-white" />
              </div>
              <span className="text-[24px] font-medium">人社知识库管理</span>
            </Link>
          )}

          <Link
            to="/next-chats"
            className="w-[380px] h-[180px] group bg-white/20 backdrop-blur-xl border border-white/30 rounded-2xl shadow-xl flex items-center justify-center px-8 gap-6 hover:bg-white/30 hover:scale-105 transition-all"
          >
            <div className="w-16 h-16 bg-gradient-to-b from-blue-300 to-blue-500 rounded-xl flex items-center justify-center">
              <Bot size={32} className="text-white" />
            </div>
            <span className="text-[24px] font-medium">人社智能问答</span>
          </Link>

          {showDashboardFiles && (
            <Link
              to="/files"
              className="w-[380px] h-[180px] group bg-white/20 backdrop-blur-xl border border-white/30 rounded-2xl shadow-xl flex items-center justify-center px-8 gap-6 hover:bg-white/30 hover:scale-105 transition-all"
            >
              <div className="w-16 h-16 bg-gradient-to-b from-green-400 to-green-600 rounded-xl flex items-center justify-center">
                <FileText size={32} className="text-white" />
              </div>
              <span className="text-[24px] font-medium">人社文件管理</span>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
