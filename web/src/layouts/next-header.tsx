import logoImg from '@/assets/logo.png';
import { RAGFlowAvatar } from '@/components/ragflow-avatar';
import { Button } from '@/components/ui/button';
import { Segmented, SegmentedValue } from '@/components/ui/segmented';
import { useNavigateWithFromState } from '@/hooks/route-hook';
import { useSystemRoleAccess } from '@/hooks/use-system-role-access';
import { useLogout } from '@/hooks/use-login-request';
import { useFetchUserInfo } from '@/hooks/use-user-setting-request';
import { Routes } from '@/routes';
import {
  File,
  House,
  Library,
  MessageSquareText,
} from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

const PathMap = {
  [Routes.Datasets]: [Routes.Datasets],
  [Routes.Chats]: [Routes.Chats],
  [Routes.Files]: [Routes.Files],
} as const;

export function Header() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigate = useNavigateWithFromState();
  const { logout } = useLogout();
  const {
    data: { avatar, nickname },
  } = useFetchUserInfo();
  const { isSuperAdmin, showDatasetNav, showFileNav, showProfileAvatar } =
    useSystemRoleAccess();

  const tagsData = useMemo(() => {
    const baseMenu = [
      { path: Routes.Root, icon: House },
      { path: Routes.Chats, name: t('header.chat'), icon: MessageSquareText },
    ];

    if (showDatasetNav) {
      baseMenu.push({
        path: Routes.Datasets,
        name: t('header.dataset'),
        icon: Library,
      });
    }

    if (showFileNav) {
      baseMenu.push({
        path: Routes.Files,
        name: t('header.fileManager'),
        icon: File,
      });
    }

    return baseMenu;
  }, [showDatasetNav, showFileNav, t]);

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

  const handleProfileClick = useCallback(() => {
    if (isSuperAdmin) {
      navigate(Routes.UserSetting);
      return;
    }

    navigate(`${Routes.UserSetting}${Routes.Team}`);
  }, [isSuperAdmin, navigate]);

  const activePathName = useMemo(() => {
    const name = Object.keys(PathMap).find((x: string) => {
      const pathList = PathMap[x as keyof typeof PathMap];
      return pathList.some((y: string) => pathname.indexOf(y) > -1);
    });

    return name || pathname;
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
      <div className="flex items-center gap-4">
        <img
          src={logoImg}
          alt="logo"
          className="h-10 w-auto mr-[12] cursor-pointer object-contain"
          onClick={handleLogoClick}
        />
      </div>

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

      <div className="flex items-center justify-end h-10 min-w-[120px]">
        {showProfileAvatar ? (
          <RAGFlowAvatar
            name={nickname}
            avatar={avatar}
            isPerson
            className="size-8 cursor-pointer"
            onClick={handleProfileClick}
          />
        ) : (
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
