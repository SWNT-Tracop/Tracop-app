import { DomainError } from '../../../shared/kernel/domain-error.js';
import { PhoneNumber } from './phone-number.js';

export const USER_ROLES = [
  'producer',
  'supplier',
  'buyer',
  'carrier',
  'operator',
  'finance',
  'admin',
] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const SELF_REGISTERABLE_ROLES: readonly UserRole[] = [
  'producer',
  'supplier',
  'buyer',
  'carrier',
];
export type UserStatus = 'pending_verification' | 'active' | 'suspended';

export interface UserRegistered {
  readonly type: 'UserRegistered';
  readonly userId: string;
  readonly role: UserRole;
  readonly occurredAt: string;
}

export interface UserVerified {
  readonly type: 'UserVerified';
  readonly userId: string;
  readonly occurredAt: string;
}

export type UserEvent = UserRegistered | UserVerified;

export interface UserProps {
  id: string;
  phone: PhoneNumber;
  role: UserRole;
  fullName: string;
  locale: string;
  status: UserStatus;
  phoneVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class User {
  private constructor(readonly props: UserProps) {}

  static register(
    props: Omit<UserProps, 'status' | 'phoneVerifiedAt' | 'updatedAt'>,
    occurredAt: Date,
  ): User {
    if (!SELF_REGISTERABLE_ROLES.includes(props.role)) {
      throw new DomainError('Este rol debe ser creado por el equipo autorizado.', 'invalid_role');
    }
    return new User({
      ...props,
      status: 'pending_verification',
      phoneVerifiedAt: null,
      updatedAt: occurredAt,
    });
  }

  static createStaff(
    props: Omit<UserProps, 'status' | 'phoneVerifiedAt' | 'updatedAt'>,
    occurredAt: Date,
  ): User {
    if (SELF_REGISTERABLE_ROLES.includes(props.role)) {
      throw new DomainError('El comando de staff solo crea roles privilegiados.', 'invalid_role');
    }
    return new User({
      ...props,
      status: 'active',
      phoneVerifiedAt: occurredAt,
      updatedAt: occurredAt,
    });
  }

  static rehydrate(props: UserProps): User {
    return new User(props);
  }

  verifyPhone(occurredAt: Date): UserVerified {
    if (this.props.status === 'suspended') {
      throw new DomainError('La cuenta está suspendida.', 'user_suspended');
    }
    this.props.status = 'active';
    this.props.phoneVerifiedAt = occurredAt;
    this.props.updatedAt = occurredAt;
    return { type: 'UserVerified', userId: this.props.id, occurredAt: occurredAt.toISOString() };
  }

  updateProfile(input: { fullName?: string; locale?: string }, occurredAt: Date): void {
    if (input.fullName !== undefined) this.props.fullName = input.fullName;
    if (input.locale !== undefined) this.props.locale = input.locale;
    this.props.updatedAt = occurredAt;
  }

  registeredEvent(): UserRegistered {
    return {
      type: 'UserRegistered',
      userId: this.props.id,
      role: this.props.role,
      occurredAt: this.props.createdAt.toISOString(),
    };
  }
}
