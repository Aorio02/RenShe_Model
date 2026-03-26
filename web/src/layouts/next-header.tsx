import logoImg from '@/assets/logo.png';
import { RAGFlowAvatar } from '@/components/ragflow-avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Segmented, SegmentedValue } from '@/components/ui/segmented';
import { LanguageList, LanguageMap } from '@/constants/common';
import { useChangeLanguage } from '@/hooks/logic-hooks';
import { useNavigatePage } from '@/hooks/logic-hooks/navigate-hooks';
import { useNavigateWithFromState } from '@/hooks/route-hook';
import { useFetchUserInfo } from '@/hooks/use-user-setting-request';
import { useLogout } from '@/hooks/use-login-request'; // 👈 用你项目真实的退出 Hook
import { Routes } from '@/routes';
import { camelCase } from 'lodash';
import {
  ChevronDown,
  File,
  House,
  Library,
  MessageSquareText,
} from 'lucide-react';
import { useCallback, useMemo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { BellButton } from './bell-button';
import { Button } from '@/components/ui/button';

const PathMap = {
  [Routes.Datasets]: [Routes.Datasets],
  [Routes.Chats]: [Routes.Chats],
  [Routes.Files]: [Routes.Files],
} as const;

export function Header() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigate = useNavigateWithFromState();
  const { navigateToOldProfile } = useNavigatePage();
  const { logout } = useLogout(); // 👈 直接用你项目的退出方法
  const changeLanguage = useChangeLanguage();

  const {
    data: { language = 'Chinese', avatar, nickname },
  } = useFetchUserInfo();

  // ======================
  // 管理员判断（固定邮箱）
  // ======================
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const userInfoStr = localStorage.getItem('userInfo');
    if (userInfoStr) {
      const userInfo = JSON.parse(userInfoStr);
      const adminEmails = ['1223086775@qq.com'];
      setIsAdmin(adminEmails.includes(userInfo.email));
    }
  }, []);

  const handleItemClick = (key: string) => () => {
    changeLanguage(key);
  };

  const items = LanguageList.map((x) => ({
    key: x,
    label: <span>{LanguageMap[x as keyof typeof LanguageMap]}</span>,
  }));

  // ======================
  // 权限控制导航菜单
  // ======================
  const tagsData = useMemo(() => {
    const baseMenu = [
      { path: Routes.Root, name: t('header.Root'), icon: House },
      { path: Routes.Chats, name: t('header.chat'), icon: MessageSquareText },
    ];

    if (isAdmin) {
      baseMenu.push(
        { path: Routes.Datasets, name: t('header.dataset'), icon: Library },
        { path: Routes.Files, name: t('header.fileManager'), icon: File },
      );
    }

    return baseMenu;
  }, [t, isAdmin]);

  const options = useMemo(() => {
    return tagsData.map((tag) => {
      const HeaderIcon = tag.icon;

      return {
        label:
          tag.path === Routes.Root ? (
            <HeaderIcon className="size-6"></HeaderIcon>
          ) : (
            <span>{tag.name}</span>
          ),
        value: tag.path,
      };
    });
  }, [tagsData]);

  const handleChange = (path: SegmentedValue) => {
    navigate(path as Routes);
  };

  const handleLogoClick = useCallback(() => {
    navigate(Routes.Root);
  }, [navigate]);

  const activePathName = useMemo(() => {
    const name = Object.keys(PathMap).find((x: string) => {
      const pathList = PathMap[x as keyof typeof PathMap];
      return pathList.some((y: string) => pathname.indexOf(y) > -1);
    });
    if (name) {
      return name;
    } else {
      return pathname;
    }
  }, [pathname]);

  return (
    <section
      className="py-4 px-10 relative flex items-center justify-between"
      style={{
        background: 'rgba(255,255,255,0.12)',
        backdropFilter: 'blur(8px)',
        borderBottom: '1px solid rgba(255,255,255,0.2)',
      }}
    >
      {/* 左侧 LOGO */}
      <div className="flex items-center gap-4">
        <img
          src={logoImg}
          alt="logo"
          className="h-10 w-auto mr-[12] cursor-pointer object-contain"
          onClick={handleLogoClick}
        />
      </div>

      {/* 中间导航 —— 绝对居中 */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <Segmented
          rounded="xxxl"
          sizeType="xl"
          buttonSize="xl"
          options={options}
          value={activePathName}
          onChange={handleChange}
          activeClassName="text-bg-base bg-metallic-gradient border-b-[#00BEB4] border-b-2"
        />
      </div>

      {/* 右侧：管理员=头像，普通用户=退出按钮 */}
      <div className="flex items-center justify-end h-10 min-w-[120px]">
        {isAdmin ? (
          // 管理员 → 显示头像
          <RAGFlowAvatar
            name={nickname}
            avatar={avatar}
            isPerson
            className="size-8 cursor-pointer"
            onClick={navigateToOldProfile}
          />
        ) : (
          // 普通用户 → 显示退出按钮（和设置页样式统一）
          <Button
            variant="ghost"
            className="gap-2 bg-white/15 text-white border border-white/20 hover:bg-white/25 px-4"
            onClick={() => logout()}
          >
            {t('setting.logout')}
          </Button>
        )}
      </div>
    </section>
  );
}