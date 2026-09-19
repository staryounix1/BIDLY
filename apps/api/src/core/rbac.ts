import type { AdminRole, UserRole } from '@bidly/types';
import { ADMIN_ROLES } from '@bidly/config';
import { forbidden, insufficientPermissions } from './errors.js';

/**
 * Role-based and ownership-based authorization.
 *
 * Rule: never trust a role sent by the client. The role here always comes
 * from a server-verified access token or a freshly loaded database row, and
 * every resource access is additionally checked for ownership/participation.
 */

export interface AuthContext {
  userId: string;
  role: UserRole;
  sessionId: string;
  providerId?: string | null;
  adminRole?: AdminRole | null;
  permissions?: string[];
}

// --- Coarse roles -----------------------------------------------------

export function isCustomer(auth: AuthContext): boolean {
  return auth.role === 'CUSTOMER';
}

export function isProvider(auth: AuthContext): boolean {
  return auth.role === 'PROVIDER';
}

export function isAdmin(auth: AuthContext): boolean {
  return auth.role === 'ADMIN';
}

export function hasRole(auth: AuthContext, ...roles: UserRole[]): boolean {
  return roles.includes(auth.role);
}

// --- Admin permissions ------------------------------------------------

export const ADMIN_PERMISSIONS = {
  // users & providers
  USERS_READ: 'users:read',
  USERS_WRITE: 'users:write',
  USERS_SUSPEND: 'users:suspend',
  PROVIDERS_READ: 'providers:read',
  PROVIDERS_VERIFY: 'providers:verify',
  PROVIDERS_SUSPEND: 'providers:suspend',
  // catalog
  CATALOG_READ: 'catalog:read',
  CATALOG_WRITE: 'catalog:write',
  // marketplace
  REQUESTS_READ: 'requests:read',
  JOBS_READ: 'jobs:read',
  JOBS_INTERVENE: 'jobs:intervene',
  DISPUTES_READ: 'disputes:read',
  DISPUTES_RESOLVE: 'disputes:resolve',
  // money
  PAYMENTS_READ: 'payments:read',
  PAYMENTS_WRITE: 'payments:write',
  REFUNDS_CREATE: 'refunds:create',
  REFUNDS_APPROVE: 'refunds:approve',
  PAYOUTS_READ: 'payouts:read',
  PAYOUTS_APPROVE: 'payouts:approve',
  COMMISSION_WRITE: 'commission:write',
  // platform
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',
  PROMOTIONS_WRITE: 'promotions:write',
  AUDIT_READ: 'audit:read',
  SUPPORT_MANAGE: 'support:manage',
} as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[keyof typeof ADMIN_PERMISSIONS];

const ALL_PERMISSIONS: AdminPermission[] = Object.values(ADMIN_PERMISSIONS);

/** Default permission sets per admin role. A wildcard "*" grants everything. */
export const ROLE_PERMISSIONS: Record<AdminRole, AdminPermission[] | '*'> = {
  SUPER_ADMIN: '*',
  ADMIN: ALL_PERMISSIONS.filter((p) => p !== ADMIN_PERMISSIONS.COMMISSION_WRITE),
  MODERATOR: [
    ADMIN_PERMISSIONS.USERS_READ,
    ADMIN_PERMISSIONS.PROVIDERS_READ,
    ADMIN_PERMISSIONS.PROVIDERS_VERIFY,
    ADMIN_PERMISSIONS.CATALOG_READ,
    ADMIN_PERMISSIONS.REQUESTS_READ,
    ADMIN_PERMISSIONS.JOBS_READ,
    ADMIN_PERMISSIONS.DISPUTES_READ,
    ADMIN_PERMISSIONS.DISPUTES_RESOLVE,
    ADMIN_PERMISSIONS.SUPPORT_MANAGE,
    ADMIN_PERMISSIONS.AUDIT_READ,
  ],
  FINANCE: [
    ADMIN_PERMISSIONS.PAYMENTS_READ,
    ADMIN_PERMISSIONS.PAYMENTS_WRITE,
    ADMIN_PERMISSIONS.REFUNDS_CREATE,
    ADMIN_PERMISSIONS.REFUNDS_APPROVE,
    ADMIN_PERMISSIONS.PAYOUTS_READ,
    ADMIN_PERMISSIONS.PAYOUTS_APPROVE,
    ADMIN_PERMISSIONS.COMMISSION_WRITE,
    ADMIN_PERMISSIONS.USERS_READ,
    ADMIN_PERMISSIONS.PROVIDERS_READ,
    ADMIN_PERMISSIONS.JOBS_READ,
    ADMIN_PERMISSIONS.AUDIT_READ,
  ],
  SUPPORT: [
    ADMIN_PERMISSIONS.USERS_READ,
    ADMIN_PERMISSIONS.PROVIDERS_READ,
    ADMIN_PERMISSIONS.REQUESTS_READ,
    ADMIN_PERMISSIONS.JOBS_READ,
    ADMIN_PERMISSIONS.DISPUTES_READ,
    ADMIN_PERMISSIONS.SUPPORT_MANAGE,
  ],
};

export function effectivePermissions(
  role: AdminRole | null | undefined,
  explicit: string[] = [],
): string[] {
  if (!role) return explicit;
  const base = ROLE_PERMISSIONS[role];
  if (base === '*') return ['*', ...explicit];
  return Array.from(new Set([...base, ...explicit]));
}

export function hasAdminPermission(
  auth: AuthContext,
  permission: AdminPermission | AdminPermission[],
): boolean {
  if (!isAdmin(auth)) return false;
  const granted = effectivePermissions(auth.adminRole, auth.permissions ?? []);
  if (granted.includes('*')) return true;
  const needed = Array.isArray(permission) ? permission : [permission];
  return needed.every((p) => granted.includes(p));
}

export function assertAdminPermission(
  auth: AuthContext,
  permission: AdminPermission | AdminPermission[],
): void {
  if (!hasAdminPermission(auth, permission)) {
    throw isAdmin(auth) ? insufficientPermissions() : forbidden();
  }
}

// --- Ownership helpers -------------------------------------------------

/** A user may act on their own record, or an admin may act on anyone's. */
export function canAccessUserResource(auth: AuthContext, ownerUserId: string): boolean {
  return auth.role === 'ADMIN' || auth.userId === ownerUserId;
}

export function canAccessProviderResource(auth: AuthContext, providerOwnerUserId: string): boolean {
  return auth.role === 'ADMIN' || auth.userId === providerOwnerUserId;
}

/** Both sides of an exchange (customer + provider) may read its details. */
export function isPartyTo(
  auth: AuthContext,
  partyIds: Array<string | null | undefined>,
): boolean {
  if (auth.role === 'ADMIN') return true;
  return partyIds.some((id) => id != null && id === auth.userId);
}
