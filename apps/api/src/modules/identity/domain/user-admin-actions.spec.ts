import { PhoneNumber } from './phone-number.js';
import { User, type UserProps } from './user.js';

const phone = PhoneNumber.parse('3001234567');
if (!phone.ok) throw phone.error;
const now = new Date('2026-01-01T00:00:00.000Z');
const later = new Date('2026-01-02T00:00:00.000Z');

const user = (overrides: Partial<UserProps> = {}) =>
  User.rehydrate({
    id: 'user-1',
    role: 'buyer',
    phone: phone.value,
    fullName: 'Persona',
    locale: 'es-CO',
    status: 'active',
    phoneVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

const errorCode = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('User admin actions', () => {
  it('moves a marketplace account to another marketplace role', () => {
    const account = user();
    expect(account.changeRole('producer', later)).toEqual({
      type: 'UserRoleChanged',
      userId: 'user-1',
      from: 'buyer',
      to: 'producer',
      occurredAt: later.toISOString(),
    });
    expect(account.props.role).toBe('producer');
    expect(account.props.updatedAt).toBe(later);
  });

  it('never gives or takes a staff role, nor repeats the same role', () => {
    expect(errorCode(() => user().changeRole('admin', later))).toBe('role_not_changeable');
    expect(errorCode(() => user({ role: 'operator' }).changeRole('buyer', later))).toBe(
      'role_not_changeable',
    );
    expect(errorCode(() => user().changeRole('buyer', later))).toBe('same_role');
    expect(errorCode(() => user({ status: 'expired' }).changeRole('producer', later))).toBe(
      'not_found',
    );
  });

  it('suspends and reactivates, back to the state the phone allows', () => {
    const verified = user();
    expect(verified.suspend(later).type).toBe('UserSuspended');
    expect(verified.props.status).toBe('suspended');
    expect(errorCode(() => verified.suspend(later))).toBe('invalid_transition');
    expect(verified.reactivate(later).type).toBe('UserReactivated');
    expect(verified.props.status).toBe('active');

    const unverified = user({ status: 'suspended', phoneVerifiedAt: null });
    unverified.reactivate(later);
    expect(unverified.props.status).toBe('pending_verification');
    expect(errorCode(() => user().reactivate(later))).toBe('invalid_transition');
    expect(errorCode(() => user({ status: 'expired' }).suspend(later))).toBe('not_found');
  });
});
