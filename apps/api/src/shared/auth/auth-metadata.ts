import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = 'auth:public';
export const REQUIRED_ROLES = 'auth:roles';

export const Public = (): MethodDecorator => SetMetadata(PUBLIC_ROUTE, true);
export const Roles = (...roles: string[]): MethodDecorator => SetMetadata(REQUIRED_ROLES, roles);
