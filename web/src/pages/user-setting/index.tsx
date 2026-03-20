import { Outlet } from 'react-router';
import { SideBar } from './sidebar';

import { PageHeader } from '@/components/page-header';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { useNavigatePage } from '@/hooks/logic-hooks/navigate-hooks';
import { cn } from '@/lib/utils';
import { House } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from './index.module.less';
import backImg from '@/assets/back.png';
const UserSetting = () => {
  const { t } = useTranslation();
  const { navigateToHome } = useNavigatePage();

  return (
    <section className="flex flex-col h-full relative overflow-hidden bg-gradient-to-br from-[#4A9FE0] via-[#2979C2] to-[#1565C0] text-white">
      <div
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 0,
          backgroundImage: `url(${backImg})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          opacity: 0.1,
          maskImage:
            'radial-gradient(ellipse 85% 85% at 50% 50%, black 30%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 85% 85% at 50% 50%, black 30%, transparent 100%)',
        }}
      />
      <div className="relative z-10 flex flex-col h-full">
      <PageHeader>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink onClick={navigateToHome}>
                <House className="size-4" />
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{t('setting.profile')}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PageHeader>
      <div
        className={cn(
          styles.settingWrapper,
          'overflow-auto flex flex-1 p-4 gap-4',
        )}
      >
        <SideBar></SideBar>
        <div className={cn(styles.outletWrapper, 'flex flex-1 rounded-2xl bg-white/5 backdrop-blur-sm border border-white/10')}>
          <Outlet></Outlet>
        </div>
      </div>
      </div>
    </section>
  );
};

export default UserSetting;
