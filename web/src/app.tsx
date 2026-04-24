import { Toaster as Sonner } from '@/components/ui/sonner';
import { Toaster } from '@/components/ui/toaster';
import { LanguageAbbreviation } from '@/constants/common';
import i18n from '@/locales/config';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configResponsive } from 'ahooks';
import { App, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import advancedFormat from 'dayjs/plugin/advancedFormat';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import localeData from 'dayjs/plugin/localeData';
import weekOfYear from 'dayjs/plugin/weekOfYear';
import weekYear from 'dayjs/plugin/weekYear';
import weekday from 'dayjs/plugin/weekday';
import { useEffect } from 'react';
import { RouterProvider } from 'react-router';
import { ThemeProvider, useTheme } from './components/theme-provider';
import { SidebarProvider } from './components/ui/sidebar';
import { TooltipProvider } from './components/ui/tooltip';
import { ThemeEnum } from './constants/common';
// import { getRouter } from './routes';
import { routers } from './routes';
import storage from './utils/authorization-util';

import 'react-photo-view/dist/react-photo-view.css';

configResponsive({
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
  '3xl': 1780,
  '4xl': 1980,
});

dayjs.extend(customParseFormat);
dayjs.extend(advancedFormat);
dayjs.extend(weekday);
dayjs.extend(localeData);
dayjs.extend(weekOfYear);
dayjs.extend(weekYear);
dayjs.locale('zh-cn');

// if (process.env.NODE_ENV === 'development') {
//   const whyDidYouRender = require('@welldone-software/why-did-you-render');
//   whyDidYouRender(React, {
//     trackAllPureComponents: true,
//     trackExtraHooks: [],
//     logOnDifferentValues: true,
//   });
// }
// if (process.env.NODE_ENV === 'development') {
//   import('@welldone-software/why-did-you-render').then(
//     (whyDidYouRenderModule) => {
//       const whyDidYouRender = whyDidYouRenderModule.default;
//       whyDidYouRender(React, {
//         trackAllPureComponents: true,
//         trackExtraHooks: [],
//         logOnDifferentValues: true,
//       });
//     },
//   );
// }
const queryClient = new QueryClient();

function Root({ children }: React.PropsWithChildren) {
  const { theme: themeragflow } = useTheme();

  return (
    <>
      <ConfigProvider
        theme={{
          token: {
            fontFamily: 'Inter',
          },
          algorithm:
            themeragflow === 'dark'
              ? theme.darkAlgorithm
              : theme.defaultAlgorithm,
        }}
        locale={zhCN}
      >
        <SidebarProvider className="h-full">
          <App className="w-full h-dvh relative">{children}</App>
        </SidebarProvider>
        <Sonner position={'top-right'} expand richColors closeButton></Sonner>
        <Toaster />
      </ConfigProvider>
      {/* <ReactQueryDevtools buttonPosition={'top-left'} initialIsOpen={false} /> */}
    </>
  );
}

const RootProvider = ({ children }: React.PropsWithChildren) => {
  useEffect(() => {
    storage.setLanguage(LanguageAbbreviation.Zh);
    i18n.changeLanguage(LanguageAbbreviation.Zh);
  }, []);

  return (
    <TooltipProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider
          defaultTheme={ThemeEnum.Dark}
          storageKey="ragflow-ui-theme"
        >
          <Root>{children}</Root>
        </ThemeProvider>
      </QueryClientProvider>
    </TooltipProvider>
  );
};

export default function AppContainer() {
  // const [router, setRouter] = useState<any>(null);

  // useEffect(() => {
  //   getRouter().then(setRouter);
  // }, []);

  // if (!router) {
  //   return <div>Loading...</div>;
  // }

  return (
    <RootProvider>
      <RouterProvider router={routers}></RouterProvider>
      {/* <RouterProvider router={router}></RouterProvider> */}
    </RootProvider>
  );
}
