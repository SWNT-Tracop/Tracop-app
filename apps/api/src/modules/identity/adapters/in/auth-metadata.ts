import type { UserRole } from '../../domain/user.js';
import {
  Public as SharedPublic,
  Roles as SharedRoles,
  PUBLIC_ROUTE,
  REQUIRED_ROLES,
} from '../../../../shared/auth/index.js';

export { PUBLIC_ROUTE, REQUIRED_ROLES };
export const Public = SharedPublic;
export const Roles = (...roles: UserRole[]): MethodDecorator => SharedRoles(...roles);
