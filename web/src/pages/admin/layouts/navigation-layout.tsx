import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useNavigate } from 'react-router';
import logoImg from '@/assets/logo.png';
import backImg from '@/assets/back.png';

import { useMutation, useQuery } from '@tanstack/react-query';

import {
  LucideMonitor,
  LucideServerCrash,
  LucideSquareUserRound,
  LucideUserCog,
  LucideUserStar,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Routes } from '@/routes';
import { getSystemVersion, logout } from '@/services/admin-service';

import authorizationUtil from '@/utils/authorization-util';

import ThemeSwitch from '../components/theme-switch';
import { IS_ENTERPRISE } from '../utils';

const AdminNavigationLayout = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const { data: version } = useQuery({
    queryKey: ['admin/version'],
    queryFn: async () => (await getSystemVersion())?.data?.data?.version,
  });

  const navItems = useMemo(
    () => [
      {
        path: Routes.AdminServices,
        name: t('admin.serviceStatus'),
        icon: <LucideServerCrash className="size-[1em]" />,
      },
      {
        path: Routes.AdminUserManagement,
        name: t('admin.userManagement'),
        icon: <LucideUserCog className="size-[1em]" />,
      },
      ...(IS_ENTERPRISE
        ? [
            {
              path: Routes.AdminWhitelist,
              name: t('admin.registrationWhitelist'),
              icon: <LucideUserStar className="size-[1em]" />,
            },
            {
              path: Routes.AdminRoles,
              name: t('admin.roles'),
              icon: <LucideSquareUserRound className="size-[1em]" />,
            },
            {
              path: Routes.AdminMonitoring,
              name: t('admin.monitoring'),
              icon: <LucideMonitor className="size-[1em]" />,
            },
          ]
        : []),
    ],
    [t],
  );

  const logoutMutation = useMutation({
    mutationKey: ['adminLogout'],
    mutationFn: async () => {
      await logout();
      authorizationUtil.removeAll();
      navigate(Routes.Admin);
    },
    retry: false,
  });

  return (
    // <main className="w-screen h-screen flex flex-row px-6 pt-12 pb-6 dark:*:focus-visible:ring-white">
    //   <aside className="w-72 mr-6 flex flex-col gap-6">
    <main className="w-screen h-screen flex flex-row px-6 pt-12 pb-6 dark:*:focus-visible:ring-white relative overflow-hidden bg-gradient-to-br from-[#4A9FE0] via-[#2979C2] to-[#1565C0] text-white">
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
      <aside className="w-72 mr-6 flex flex-col gap-6 relative z-10 bg-white/10 backdrop-blur-md p-6 rounded-2xl border border-white/20">
        <div className="flex items-center mb-6">
          {/* <img className="size-8 mr-5" src="/logo.svg" alt="logo" /> */}
          <img className="size-8 mr-5" src={logoImg} alt="logo" />
          <span className="text-xl font-bold">{t('admin.title')}</span>
        </div>

        <nav>
          <ul className="space-y-4">
            {navItems.map((it) => (
              <li key={it.path}>
                <NavLink
                  to={it.path}
                  className={({ isActive }) =>
                    cn(
                      'px-4 py-3 rounded-lg',
                      'text-base w-full flex items-center justify-start text-text-secondary',
                      'hover:bg-bg-card focus:bg-bg-card focus-visible:bg-bg-card',
                      'hover:text-text-primary focus:text-text-primary focus-visible:text-text-primary',
                      'active:text-text-primary',
                      'transition-colors',
                      {
                        'bg-bg-card text-text-primary': isActive,
                      },
                    )
                  }
                >
                  {it.icon}
                  <span className="ml-3">{it.name}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-auto space-y-4">
          <div className="flex justify-between items-center">
            <span className="leading-none text-xs text-accent-primary">
              {version}
            </span>

            <ThemeSwitch />
          </div>

          <Button
            size="lg"
            variant="transparent"
            block
            onClick={() => logoutMutation.mutate()}
          >
            {t('header.logout')}
          </Button>
        </div>
      </aside>

      {/* <section className="flex-1 h-full"> */}
      <section className="flex-1 h-full relative z-10 bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 overflow-auto">
        <Outlet />
      </section>
    </main>
  );
};

export default AdminNavigationLayout;
