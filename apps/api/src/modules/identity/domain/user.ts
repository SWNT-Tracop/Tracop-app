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

export const DEFAULT_SUPPORTED_LOCALES: readonly string[] = ['es-CO', 'en'];
export const FULL_NAME_MIN_LENGTH = 2;
export const FULL_NAME_MAX_LENGTH = 160;

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

export interface UserValidationSettings {
  readonly supportedLocales?: readonly string[];
}

export const fullNameError = (fullName: string): DomainError | null => {
  const length = fullName.trim().length;
  if (length < FULL_NAME_MIN_LENGTH || length > FULL_NAME_MAX_LENGTH) {
    return new DomainError(
      `El nombre debe tener entre ${FULL_NAME_MIN_LENGTH} y ${FULL_NAME_MAX_LENGTH} caracteres.`,
      'invalid_full_name',
    );
  }
  if (CONTROL_CHARACTERS.test(fullName)) {
    return new DomainError(
      'El nombre no puede contener caracteres de control.',
      'invalid_full_name',
    );
  }
  return null;
};

export const localeError = (
  locale: string,
  supportedLocales: readonly string[],
): DomainError | null =>
  supportedLocales.includes(locale)
    ? null
    : new DomainError('Idioma no soportado.', 'unsupported_locale');

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
    settings: UserValidationSettings = {},
  ): User {
    if (!SELF_REGISTERABLE_ROLES.includes(props.role)) {
      throw new DomainError('Este rol debe ser creado por el equipo autorizado.', 'invalid_role');
    }
    const validationError =
      fullNameError(props.fullName) ??
      localeError(props.locale, settings.supportedLocales ?? DEFAULT_SUPPORTED_LOCALES);
    if (validationError) throw validationError;
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
    settings: UserValidationSettings = {},
  ): User {
    if (SELF_REGISTERABLE_ROLES.includes(props.role)) {
      throw new DomainError('El comando de staff solo crea roles privilegiados.', 'invalid_role');
    }
    const validationError =
      fullNameError(props.fullName) ??
      localeError(props.locale, settings.supportedLocales ?? DEFAULT_SUPPORTED_LOCALES);
    if (validationError) throw validationError;
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

  updateProfile(
    input: { fullName?: string; locale?: string },
    occurredAt: Date,
    settings: UserValidationSettings = {},
  ): void {
    if (input.fullName !== undefined) {
      const error = fullNameError(input.fullName);
      if (error) throw error;
      this.props.fullName = input.fullName;
    }
    if (input.locale !== undefined) {
      const error = localeError(
        input.locale,
        settings.supportedLocales ?? DEFAULT_SUPPORTED_LOCALES,
      );
      if (error) throw error;
      this.props.locale = input.locale;
    }
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
