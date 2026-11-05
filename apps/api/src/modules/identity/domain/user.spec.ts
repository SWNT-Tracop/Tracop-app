import { PhoneNumber } from './phone-number.js';
import { User, type UserProps } from './user.js';

const phone = PhoneNumber.parse('3001234567');
if (!phone.ok) throw phone.error;
const now = new Date('2026-01-01T00:00:00.000Z');

describe('User', () => {
  it.each(['producer', 'supplier', 'buyer', 'carrier'] as const)(
    'allows self-registration for %s',
    (role) => {
      const user = User.register(
        {
          id: 'user-1',
          role,
          phone: phone.value,
          fullName: 'Test',
          locale: 'es-CO',
          createdAt: now,
        },
        now,
      );
      expect(user.props.status).toBe('pending_verification');
      expect(user.props.phoneVerifiedAt).toBeNull();
    },
  );

  it.each(['operator', 'finance', 'admin'] as const)('rejects self-registration for %s', (role) => {
    expect(() =>
      User.register(
        {
          id: 'user-1',
          role,
          phone: phone.value,
          fullName: 'Test',
          locale: 'es-CO',
          createdAt: now,
        },
        now,
      ),
    ).toThrow('rol debe ser creado');
  });

  it('activates a pending account and emits verification event', () => {
    const user = User.register(
      {
        id: 'user-1',
        role: 'buyer',
        phone: phone.value,
        fullName: 'Test',
        locale: 'es-CO',
        createdAt: now,
      },
      now,
    );
    expect(user.verifyPhone(now).type).toBe('UserVerified');
    expect(user.props.status).toBe('active');
    expect(user.props.phoneVerifiedAt).toEqual(now);
  });

  it('does not verify a suspended account', () => {
    const user = User.rehydrate({
      id: 'user-1',
      role: 'buyer',
      phone: phone.value,
      fullName: 'Test',
      locale: 'es-CO',
      status: 'suspended',
      phoneVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(() => user.verifyPhone(now)).toThrow('suspendida');
  });

  it('creates staff accounts only for privileged roles and starts them active', () => {
    const staff = User.createStaff(
      {
        id: 'staff-1',
        role: 'operator',
        phone: phone.value,
        fullName: 'Operador',
        locale: 'es-CO',
        createdAt: now,
      },
      now,
    );
    expect(staff.props.status).toBe('active');
    expect(staff.registeredEvent().type).toBe('UserRegistered');
    expect(() =>
      User.createStaff(
        {
          id: 'staff-2',
          role: 'buyer',
          phone: phone.value,
          fullName: 'Comprador',
          locale: 'es-CO',
          createdAt: now,
        },
        now,
      ),
    ).toThrow('roles privilegiados');
  });

  it('updates only profile attributes provided by the application', () => {
    const user = User.register(
      {
        id: 'user-1',
        role: 'buyer',
        phone: phone.value,
        fullName: 'Test',
        locale: 'es-CO',
        createdAt: now,
      },
      now,
    );
    user.updateProfile({ fullName: 'Nuevo Nombre' }, now);
    expect(user.props.fullName).toBe('Nuevo Nombre');
    expect(user.props.phone.value).toBe('+573001234567');
    expect(user.props.role).toBe('buyer');
  });

  it('updates the locale without changing other user fields', () => {
    const user = User.register(
      {
        id: 'user-1',
        role: 'buyer',
        phone: phone.value,
        fullName: 'Test',
        locale: 'es-CO',
        createdAt: now,
      },
      now,
    );
    user.updateProfile({ locale: 'en' }, now);
    expect(user.props.locale).toBe('en');
    expect(user.props.fullName).toBe('Test');
  });

  describe('profile validation', () => {
    const validProps: Omit<UserProps, 'status' | 'phoneVerifiedAt' | 'updatedAt'> = {
      id: 'user-1',
      role: 'buyer',
      phone: phone.value,
      fullName: 'Test',
      locale: 'es-CO',
      createdAt: now,
    };

    it('rejects registration when locale is unsupported', () => {
      expect(() =>
        User.register({ ...validProps, locale: 'fr' }, now, {
          supportedLocales: ['es-CO', 'en'],
        }),
      ).toThrow('no soportado');
    });

    it('rejects registration when full name is too short', () => {
      expect(() =>
        User.register({ ...validProps, fullName: 'T' }, now, {
          supportedLocales: ['es-CO', 'en'],
        }),
      ).toThrow('nombre');
    });

    it('rejects registration when full name exceeds 160 characters', () => {
      expect(() =>
        User.register({ ...validProps, fullName: 'A'.repeat(161) }, now, {
          supportedLocales: ['es-CO', 'en'],
        }),
      ).toThrow('nombre');
    });

    it('rejects registration when full name contains a control character', () => {
      expect(() =>
        User.register({ ...validProps, fullName: 'Test\u{0001}Name' }, now, {
          supportedLocales: ['es-CO', 'en'],
        }),
      ).toThrow('control');
    });

    it('rejects profile update when locale is unsupported', () => {
      const user = User.register(validProps, now, {
        supportedLocales: ['es-CO', 'en'],
      });
      expect(() => user.updateProfile({ locale: 'fr' }, now)).toThrow('no soportado');
      expect(user.props.locale).toBe('es-CO');
    });

    it('rejects profile update when full name contains a control character', () => {
      const user = User.register(validProps, now, {
        supportedLocales: ['es-CO', 'en'],
      });
      expect(() => user.updateProfile({ fullName: 'T\u{007F}est' }, now)).toThrow('control');
      expect(user.props.fullName).toBe('Test');
    });

    it('creates staff accounts respecting the same locale rules', () => {
      expect(() =>
        User.createStaff(
          { ...validProps, role: 'operator', fullName: 'Operador', locale: 'fr' },
          now,
          { supportedLocales: ['es-CO', 'en'] },
        ),
      ).toThrow('no soportado');
    });
  });
});
