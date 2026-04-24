export const SystemRole = {
  SuperAdmin: 'super_admin',
  Admin: 'admin',
  User: 'user',
} as const;

export type SystemRoleValue =
  (typeof SystemRole)[keyof typeof SystemRole];

export const DEFAULT_SYSTEM_ROLE = SystemRole.User;

export const resolveSystemRole = (
  systemRole?: string | null,
  isSuperuser?: boolean,
): SystemRoleValue => {
  if (
    systemRole === SystemRole.SuperAdmin ||
    systemRole === SystemRole.Admin ||
    systemRole === SystemRole.User
  ) {
    return systemRole;
  }

  if (isSuperuser) {
    return SystemRole.SuperAdmin;
  }

  return DEFAULT_SYSTEM_ROLE;
};
