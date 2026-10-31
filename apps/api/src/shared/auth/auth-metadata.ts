import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@tracop/contracts';

export const PUBLIC_ROUTE = 'auth:public';
export const REQUIRED_ROLES = 'auth:roles';

export const Public = (): MethodDecorator => SetMetadata(PUBLIC_ROUTE, true);
export const Roles = (...roles: UserRole[]): MethodDecorator => SetMetadata(REQUIRED_ROLES, roles);
