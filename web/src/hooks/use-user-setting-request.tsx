import message from '@/components/ui/message';
import { ResponseGetType } from '@/interfaces/database/base';
import { IToken } from '@/interfaces/database/chat';
import { ITenantInfo } from '@/interfaces/database/knowledge';
import { ILangfuseConfig } from '@/interfaces/database/system';
import {
  ISystemStatus,
  ITenant,
  ITenantUser,
  IUserInfo,
} from '@/interfaces/database/user-setting';
import { ISetLangfuseConfigRequestBody } from '@/interfaces/request/system';
import userService, {
  addTenantUser,
  agreeTenant,
  deleteTenantUser,
  listTenant,
  listTenantUser,
} from '@/services/user-service';
import { history } from '@/utils/simple-history-util';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from 'antd';
import DOMPurify from 'dompurify';
import { isEmpty } from 'lodash';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export const enum UserSettingApiAction {
  UserInfo = 'userInfo',
  TenantInfo = 'tenantInfo',
  SaveSetting = 'saveSetting',
  FetchManualSystemTokenList = 'fetchManualSystemTokenList',
  FetchSystemTokenList = 'fetchSystemTokenList',
  RemoveSystemToken = 'removeSystemToken',
  CreateSystemToken = 'createSystemToken',
  ListTenantUser = 'listTenantUser',
  AddTenantUser = 'addTenantUser',
  DeleteTenantUser = 'deleteTenantUser',
  ListTenant = 'listTenant',
  AgreeTenant = 'agreeTenant',
  SetLangfuseConfig = 'setLangfuseConfig',
  DeleteLangfuseConfig = 'deleteLangfuseConfig',
  FetchLangfuseConfig = 'fetchLangfuseConfig',
}

const USER_SETTING_STALE_TIME = 5 * 60 * 1000;
const USER_SETTING_GC_TIME = 30 * 60 * 1000;

export const useFetchUserInfo = (): ResponseGetType<IUserInfo> => {
  const queryClient = useQueryClient();
  const queryKey = [UserSettingApiAction.UserInfo] as const;
  const cachedInitialData = queryClient.getQueryData<IUserInfo>(queryKey);
  const hasCachedInitialData = !isEmpty(cachedInitialData);

  const { data, isFetching: loading } = useQuery({
    queryKey,
    initialData: hasCachedInitialData ? cachedInitialData : undefined,
    gcTime: USER_SETTING_GC_TIME,
    staleTime: hasCachedInitialData ? USER_SETTING_STALE_TIME : 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    retry: 2,
    queryFn: async () => {
      const cachedData = queryClient.getQueryData<IUserInfo>(queryKey);
      const hasCachedData = !isEmpty(cachedData);

      try {
        const { data } = await userService.user_info();
        if (data.code === 0) {
          const userInfo = data?.data ?? ({} as IUserInfo);
          return userInfo;
        }
      } catch {
        if (hasCachedData) {
          return cachedData;
        }
        throw new Error('Failed to fetch user info');
      }

      if (hasCachedData) {
        return cachedData;
      }

      throw new Error('Failed to fetch user info');
    },
  });

  return { data: data ?? ({} as IUserInfo), loading };
};

export const useFetchTenantInfo = (
  showEmptyModelWarn = false,
): ResponseGetType<ITenantInfo> => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const warnedEmptyModelRef = useRef(false);
  const queryKey = [UserSettingApiAction.TenantInfo] as const;
  const cachedInitialData = queryClient.getQueryData<ITenantInfo>(queryKey);
  const hasCachedInitialData = !isEmpty(cachedInitialData);
  const { data, isFetching: loading, isFetched } = useQuery({
    queryKey,
    initialData: hasCachedInitialData ? cachedInitialData : undefined,
    gcTime: USER_SETTING_GC_TIME,
    staleTime: hasCachedInitialData ? USER_SETTING_STALE_TIME : 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    retry: 2,
    queryFn: async () => {
      const cachedData = queryClient.getQueryData<ITenantInfo>(queryKey);
      const hasCachedData = !isEmpty(cachedData);

      try {
        const { data: res } = await userService.get_tenant_info();
        if (res.code === 0) {
          // llm_id is chat_id
          // asr_id is speech2txt
          const tenantData = res.data ?? ({} as ITenantInfo);
          tenantData.chat_id = tenantData.llm_id;
          tenantData.speech2text_id = tenantData.asr_id;

          return tenantData;
        }
      } catch {
        if (hasCachedData) {
          return cachedData;
        }
        throw new Error('Failed to fetch tenant info');
      }

      if (hasCachedData) {
        return cachedData;
      }

      throw new Error('Failed to fetch tenant info');
    },
  });

  useEffect(() => {
    if (!isFetched) {
      return;
    }

    const hasModelFields =
      Object.prototype.hasOwnProperty.call(data ?? {}, 'embd_id') ||
      Object.prototype.hasOwnProperty.call(data ?? {}, 'llm_id');

    if (!hasModelFields) {
      return;
    }

    const hasEmptyModel = isEmpty(data?.embd_id) || isEmpty(data?.llm_id);

    if (!hasEmptyModel) {
      warnedEmptyModelRef.current = false;
      return;
    }

    if (!showEmptyModelWarn || warnedEmptyModelRef.current) {
      return;
    }

    warnedEmptyModelRef.current = true;
    Modal.warning({
      title: t('common.warn'),
      content: (
        <div
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(t('setting.modelProvidersWarn')),
          }}
        ></div>
      ),
      onOk() {
        history.push('/user-setting/model');
      },
    });
  }, [data, data?.embd_id, data?.llm_id, isFetched, showEmptyModelWarn, t]);

  return { data: data ?? ({} as ITenantInfo), loading };
};

const DEFAULT_PARSERS = [
  { value: 'naive', label: 'General' },
  { value: 'qa', label: 'Q&A' },
  { value: 'resume', label: 'Resume' },
  { value: 'manual', label: 'Manual' },
  { value: 'table', label: 'Table' },
  { value: 'paper', label: 'Paper' },
  { value: 'book', label: 'Book' },
  { value: 'laws', label: 'Laws' },
  { value: 'presentation', label: 'Presentation' },
  { value: 'picture', label: 'Picture' },
  { value: 'one', label: 'One' },
  { value: 'audio', label: 'Audio' },
  { value: 'email', label: 'Email' },
  { value: 'tag', label: 'Tag' },
];

export const useSelectParserList = (): Array<{
  value: string;
  label: string;
}> => {
  const { data: tenantInfo } = useFetchTenantInfo(true);

  const parserList = useMemo(() => {
    const parserArray: Array<string> = tenantInfo?.parser_ids?.split(',') ?? [];
    const filteredArray = parserArray.filter((x) => x.trim() !== '');

    if (filteredArray.length === 0) {
      return DEFAULT_PARSERS;
    }

    return filteredArray.map((x) => {
      const arr = x.split(':');
      return { value: arr[0], label: arr[1] };
    });
  }, [tenantInfo]);

  return parserList;
};

export const useSaveSetting = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [UserSettingApiAction.SaveSetting],
    mutationFn: async (
      userInfo: { new_password: string } | Partial<IUserInfo>,
    ) => {
      const { data } = await userService.setting(userInfo);
      if (data.code === 0) {
        message.success(t('message.modified'));
        queryClient.invalidateQueries({ queryKey: ['userInfo'] });
      }
      return data?.code;
    },
  });

  return { data, loading, saveSetting: mutateAsync };
};

export const useFetchSystemVersion = () => {
  const [version, setVersion] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchSystemVersion = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await userService.getSystemVersion();
      if (data.code === 0) {
        setVersion(data.data);
        setLoading(false);
      }
    } catch {
      setLoading(false);
    }
  }, []);

  return { fetchSystemVersion, version, loading };
};

export const useFetchSystemStatus = () => {
  const [systemStatus, setSystemStatus] = useState<ISystemStatus>(
    {} as ISystemStatus,
  );
  const [loading, setLoading] = useState(false);

  const fetchSystemStatus = useCallback(async () => {
    setLoading(true);
    const { data } = await userService.getSystemStatus();
    if (data.code === 0) {
      setSystemStatus(data.data);
      setLoading(false);
    }
  }, []);

  return {
    systemStatus,
    fetchSystemStatus,
    loading,
  };
};

export const useFetchManualSystemTokenList = () => {
  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [UserSettingApiAction.FetchManualSystemTokenList],
    mutationFn: async () => {
      const { data } = await userService.listToken();

      return data?.data ?? [];
    },
  });

  return { data, loading, fetchSystemTokenList: mutateAsync };
};

export const useFetchSystemTokenList = () => {
  const {
    data,
    isFetching: loading,
    refetch,
  } = useQuery<IToken[]>({
    queryKey: [UserSettingApiAction.FetchSystemTokenList],
    initialData: [],
    gcTime: 0,
    queryFn: async () => {
      const { data } = await userService.listToken();

      return data?.data ?? [];
    },
  });

  return { data, loading, refetch };
};

export const useRemoveSystemToken = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [UserSettingApiAction.RemoveSystemToken],
    mutationFn: async (token: string) => {
      const { data } = await userService.removeToken({}, token);
      if (data.code === 0) {
        message.success(t('message.deleted'));
        queryClient.invalidateQueries({
          queryKey: [UserSettingApiAction.FetchSystemTokenList],
        });
      }
      return data?.data ?? [];
    },
  });

  return { data, loading, removeToken: mutateAsync };
};

export const useCreateSystemToken = () => {
  const queryClient = useQueryClient();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [UserSettingApiAction.CreateSystemToken],
    mutationFn: async (params: Record<string, any>) => {
      const { data } = await userService.createToken(params);
      if (data.code === 0) {
        queryClient.invalidateQueries({
          queryKey: [UserSettingApiAction.FetchSystemTokenList],
        });
      }
      return data?.data ?? [];
    },
  });

  return { data, loading, createToken: mutateAsync };
};

export const useListTenantUser = () => {
  const { data: tenantInfo } = useFetchTenantInfo();
  const tenantId = tenantInfo.tenant_id;
  const {
    data,
    isFetching: loading,
    refetch,
  } = useQuery<ITenantUser[]>({
    queryKey: [UserSettingApiAction.ListTenantUser, tenantId],
    initialData: [],
    gcTime: 0,
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await listTenantUser(tenantId);

      return data?.data ?? [];
    },
  });

  return { data, loading, refetch };
};

export const useAddTenantUser = () => {
  const { data: tenantInfo } = useFetchTenantInfo();
  const queryClient = useQueryClient();
  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [UserSettingApiAction.AddTenantUser],
    mutationFn: async (email: string) => {
      const { data } = await addTenantUser(tenantInfo.tenant_id, email);
      if (data.code === 0) {
        queryClient.invalidateQueries({
          queryKey: [UserSettingApiAction.ListTenantUser],
        });
      }
      return data?.code;
    },
  });

  return { data, loading, addTenantUser: mutateAsync };
};

export const useDeleteTenantUser = () => {
  const { data: tenantInfo } = useFetchTenantInfo();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [UserSettingApiAction.DeleteTenantUser],
    mutationFn: async ({
      userId,
      tenantId,
    }: {
      userId: string;
      tenantId?: string;
    }) => {
      const { data } = await deleteTenantUser({
        tenantId: tenantId ?? tenantInfo.tenant_id,
        userId,
      });
      if (data.code === 0) {
        message.success(t('message.deleted'));
        queryClient.invalidateQueries({
          queryKey: [UserSettingApiAction.ListTenantUser],
        });
        queryClient.invalidateQueries({
          queryKey: [UserSettingApiAction.ListTenant],
        });
      }
      return data?.data ?? [];
    },
  });

  return { data, loading, deleteTenantUser: mutateAsync };
};

export const useListTenant = () => {
  const { data: tenantInfo } = useFetchTenantInfo();
  const tenantId = tenantInfo.tenant_id;
  const {
    data,
    isFetching: loading,
    refetch,
  } = useQuery<ITenant[]>({
    queryKey: [UserSettingApiAction.ListTenant, tenantId],
    initialData: [],
    gcTime: 0,
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await listTenant();

      return data?.data ?? [];
    },
  });

  return { data, loading, refetch };
};

export const useAgreeTenant = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [UserSettingApiAction.AgreeTenant],
    mutationFn: async (tenantId: string) => {
      const { data } = await agreeTenant(tenantId);
      if (data.code === 0) {
        message.success(t('message.operated'));
        queryClient.invalidateQueries({
          queryKey: [UserSettingApiAction.ListTenant],
        });
      }
      return data?.data ?? [];
    },
  });

  return { data, loading, agreeTenant: mutateAsync };
};

export const useSetLangfuseConfig = () => {
  const { t } = useTranslation();
  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [UserSettingApiAction.SetLangfuseConfig],
    mutationFn: async (params: ISetLangfuseConfigRequestBody) => {
      const { data } = await userService.setLangfuseConfig(params);
      if (data.code === 0) {
        message.success(t('message.operated'));
      }
      return data?.code;
    },
  });

  return { data, loading, setLangfuseConfig: mutateAsync };
};

export const useDeleteLangfuseConfig = () => {
  const { t } = useTranslation();
  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [UserSettingApiAction.DeleteLangfuseConfig],
    mutationFn: async () => {
      const { data } = await userService.deleteLangfuseConfig();
      if (data.code === 0) {
        message.success(t('message.deleted'));
      }
      return data?.code;
    },
  });

  return { data, loading, deleteLangfuseConfig: mutateAsync };
};

export const useFetchLangfuseConfig = () => {
  const { data, isFetching: loading } = useQuery<ILangfuseConfig>({
    queryKey: [UserSettingApiAction.FetchLangfuseConfig],
    gcTime: 0,
    queryFn: async () => {
      const { data } = await userService.getLangfuseConfig();

      return data?.data;
    },
  });

  return { data, loading };
};
