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
import { Routes } from '@/routes';
import { camelCase } from 'lodash';
import {
  ChevronDown,
  File,
  House,
  Library,
  MessageSquareText,
} from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { BellButton } from './bell-button';


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

  const changeLanguage = useChangeLanguage();

  const {
    data: { language = 'English', avatar, nickname },
  } = useFetchUserInfo();

  const handleItemClick = (key: string) => () => {
    changeLanguage(key);
  };

  const items = LanguageList.map((x) => ({
    key: x,
    label: <span>{LanguageMap[x as keyof typeof LanguageMap]}</span>,
  }));


  const tagsData = useMemo(
    () => [
      { path: Routes.Root, name: t('header.Root'), icon: House },
      { path: Routes.Datasets, name: t('header.dataset'), icon: Library },
      { path: Routes.Chats, name: t('header.chat'), icon: MessageSquareText },
      { path: Routes.Files, name: t('header.fileManager'), icon: File },
    ],
    [t],
  );

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
    // 更换logo
    // <section className="py-5 px-10 flex justify-between items-center ">
    <section
      className="py-4 px-10 flex justify-between items-center"
      style={{
        background: 'rgba(255,255,255,0.12)',
        backdropFilter: 'blur(8px)',
        borderBottom: '1px solid rgba(255,255,255,0.2)',
      }}
    >
      <div className="flex items-center gap-4">
        <img
          // src={'/logo.svg'}
          src={logoImg}
          alt="logo"
          // className="size-10 mr-[12] cursor-pointer"
          className="h-10 w-auto mr-[12] cursor-pointer object-contain"
          onClick={handleLogoClick}
        />
      </div>
      <Segmented
        rounded="xxxl"
        sizeType="xl"
        buttonSize="xl"
        options={options}
        value={activePathName}
        onChange={handleChange}
        activeClassName="text-bg-base bg-metallic-gradient border-b-[#00BEB4] border-b-2"
      ></Segmented>
      <div className="flex items-center gap-5 text-text-badge">
        <div className="relative">
          <RAGFlowAvatar
            name={nickname}
            avatar={avatar}
            isPerson
            className="size-8 cursor-pointer"
            onClick={navigateToOldProfile}
          ></RAGFlowAvatar>
          {/* Temporarily hidden */}
          {/* <Badge className="h-5 w-8 absolute font-normal p-0 justify-center -right-8 -top-2 text-bg-base bg-gradient-to-l from-[#42D7E7] to-[#478AF5]">
            Pro
          </Badge> */}
        </div>
      </div>
    </section>
  );
}
