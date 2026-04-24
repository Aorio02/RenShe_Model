import {
  resolveSystemRole,
  SystemRole,
} from '@/constants/system-role';
import { useFetchUserInfo } from './use-user-setting-request';

export const useSystemRoleAccess = () => {
  const { data: userInfo, loading } = useFetchUserInfo();
  const systemRole = resolveSystemRole(
    userInfo?.system_role,
    userInfo?.is_superuser,
  );
  const isSuperAdmin = systemRole === SystemRole.SuperAdmin;
  const isAdmin = systemRole === SystemRole.Admin;
  const isUser = systemRole === SystemRole.User;
  const isAdminLike = isSuperAdmin || isAdmin;

  return {
    loading,
    systemRole,
    isSuperAdmin,
    isAdmin,
    isUser,
    isAdminLike,
    showDatasetNav: isAdminLike,
    showFileNav: isAdminLike,
    showDashboardDataset: isAdminLike,
    showDashboardFiles: isAdminLike,
    showDashboardModelShortcut: isSuperAdmin,
    showDatasetSidebarTesting: isSuperAdmin,
    showDatasetSidebarLogs: isSuperAdmin,
    showDatasetSidebarSetting: isSuperAdmin,
    showDatasetSidebarKnowledgeGraph: isSuperAdmin,
    showUserSettingModel: isSuperAdmin,
    showUserSettingMcp: isSuperAdmin,
    showProfileAvatar: true,
    isDatasetReadOnly: !isSuperAdmin,
  };
};
