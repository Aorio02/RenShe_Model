import { IconFontFill } from '@/components/icon-font';
import { RAGFlowAvatar } from '@/components/ragflow-avatar';
import ThemeToggle from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Domain } from '@/constants/common';
import { useSecondPathName } from '@/hooks/route-hook';
import { useLogout } from '@/hooks/use-login-request';
import {
  useFetchSystemVersion,
  useFetchUserInfo,
} from '@/hooks/use-user-setting-request';
import { cn } from '@/lib/utils';
import { Routes } from '@/routes';
import { TFunction } from 'i18next';
import { Banknote, Box } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useHandleMenuClick } from './hooks';
import logoImg from '@/assets/logo.png';
const menuItems = (t: TFunction) => [
  { icon: Box, label: t('setting.model'), key: Routes.Model },
  { icon: Banknote, label: 'MCP', key: Routes.Mcp },
];
export function SideBar() {
  const pathName = useSecondPathName();
  const { data: userInfo } = useFetchUserInfo();
  const { handleMenuClick, active } = useHandleMenuClick();
  const { version, fetchSystemVersion } = useFetchSystemVersion();
  const { t } = useTranslation();
  useEffect(() => {
    if (location.host !== Domain) {
      fetchSystemVersion();
    }
  }, [fetchSystemVersion]);
  const { logout } = useLogout();

  return (
    <aside className="w-[303px] bg-white/10 backdrop-blur-md flex flex-col border-r border-white/20">
      <div className="p-6 mb-4">
        <div className="flex items-center gap-3">
          <img src={logoImg} alt="logo" className="h-8 w-auto" />
          <span className="text-lg font-bold text-white tracking-widest">人社服务</span>
        </div>
      </div>
      <div className="px-6 flex gap-2 items-center mb-6">
        <RAGFlowAvatar
          avatar={userInfo?.avatar}
          name={userInfo?.nickname}
          isPerson
        />
        <p className="text-sm text-text-primary">{userInfo?.email}</p>
      </div>
      <div className="flex-1 overflow-auto">
        {menuItems(t).map((item, idx) => {
          const hoverKey = pathName === item.key;
          return (
            <div key={idx}>
              <div key={idx} className="mx-6 my-5 ">
                <Button
                  variant={hoverKey ? 'secondary' : 'ghost'}
                  className={cn('w-full justify-between gap-2.5 p-3 relative', {
                    'bg-white/20 text-white': active === item.key,
                    'bg-transparent text-white/70 hover:bg-white/10': active !== item.key,
                  })}
                  onClick={handleMenuClick(item.key)}
                >
                  <section className="flex items-center gap-2.5">
                    {item.key === Routes.Mcp ? (
                      <IconFontFill name={'mcp'} className="size-4 w-4 h-4" />
                    ) : (
                      <item.icon className="w-6 h-6" />
                    )}
                    <span>{item.label}</span>
                  </section>
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="p-6 mt-auto ">
        <div className="flex items-center gap-2 mb-6 justify-between">
          <div className="mr-2 px-2 text-accent-primary rounded-md">
            {version}
          </div>
          <ThemeToggle />
        </div>
        <Button
          variant="ghost"
          className="w-full gap-3 bg-bg-base border border-border-button"
          onClick={() => {
            logout();
          }}
        >
          {t('setting.logout')}
        </Button>
      </div>
    </aside>
  );
}
