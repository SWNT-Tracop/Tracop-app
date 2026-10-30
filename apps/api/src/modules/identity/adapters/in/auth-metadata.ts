import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../domain/user.js';

export const PUBLIC_ROUTE = 'identity:public';
export const REQUIRED_ROLES = 'identity:roles';
export const Public = (): MethodDecorator => SetMetadata(PUBLIC_ROUTE, true);
export const Roles = (...roles: UserRole[]): MethodDecorator => SetMetadata(REQUIRED_ROLES, roles);
