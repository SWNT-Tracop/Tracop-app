import { failure, success, type Result } from '../../../shared/kernel/result.js';
import { DomainError } from '../../../shared/kernel/domain-error.js';

export class PhoneNumber {
  private constructor(readonly value: string) {}

  static parse(
    input: string,
    allowedCountryCodes: readonly string[] = ['57'],
  ): Result<PhoneNumber, DomainError> {
    const compact = input.trim().replace(/[\s().-]/g, '');
    let countryCode: string | undefined;
    let nationalNumber: string;

    if (/^\d{10}$/.test(compact)) {
      countryCode = '57';
      nationalNumber = compact;
    } else if (/^\d{8,15}$/.test(compact)) {
      countryCode = [...allowedCountryCodes]
        .sort((left, right) => right.length - left.length)
        .find((code) => compact.startsWith(code));
      nationalNumber = countryCode ? compact.slice(countryCode.length) : '';
    } else if (/^\+\d{8,15}$/.test(compact)) {
      const digits = compact.slice(1);
      countryCode = [...allowedCountryCodes]
        .sort((left, right) => right.length - left.length)
        .find((code) => digits.startsWith(code));
      nationalNumber = countryCode ? digits.slice(countryCode.length) : '';
    } else {
      return failure(
        new DomainError(
          'El teléfono debe ser un celular válido en formato E.164 o colombiano local.',
          'invalid_phone',
        ),
      );
    }

    const validNationalNumber =
      countryCode === '57' ? /^3\d{9}$/.test(nationalNumber) : /^\d{7,12}$/.test(nationalNumber);
    if (!countryCode || !allowedCountryCodes.includes(countryCode) || !validNationalNumber) {
      return failure(
        new DomainError('El teléfono debe ser un celular de un país permitido.', 'invalid_phone'),
      );
    }
    return success(new PhoneNumber(`+${countryCode}${nationalNumber}`));
  }

  equals(other: PhoneNumber): boolean {
    return this.value === other.value;
  }
}
