import { Outlet } from 'react-router';
import { Header } from './next-header';
import backImg from '@/assets/back.png';
export default function NextLayout() {
  return (
    // 添加背景图片
    <main
      className="h-full flex flex-col relative overflow-hidden"
      style={{
        background: 'linear-gradient(135deg, #4A9FE0 0%, #2979C2 40%, #1565C0 100%)',
      }}
    >
      {/* back.png background - softened edges, low opacity */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 0,
          backgroundImage: `url(${backImg})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          opacity: 0.13,
          maskImage:
            'radial-gradient(ellipse 85% 85% at 50% 50%, black 30%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 85% 85% at 50% 50%, black 30%, transparent 100%)',
        }}
      />
      {/* Content above background */}
      <div className="relative z-10 flex flex-col h-full">
        <Header />
        <Outlet />
      </div>
    </main>
  );
}
