import { PhoneNumber } from './phone-number.js';

describe('PhoneNumber', () => {
  it.each(['3001234567', '573001234567', '+573001234567'])(
    'normalizes %s to Colombian E.164',
    (input) => {
      const phone = PhoneNumber.parse(input);
      expect(phone.ok).toBe(true);
      if (phone.ok) expect(phone.value.value).toBe('+573001234567');
    },
  );

  it.each(['6012345678', '+14155550123', '300123456', '57300123456', 'not-a-number'])(
    'rejects %s by default',
    (input) => {
      const phone = PhoneNumber.parse(input);
      expect(phone.ok).toBe(false);
    },
  );

  it('supports an explicitly allowed non-Colombian calling code', () => {
    const phone = PhoneNumber.parse('+14155550123', ['57', '1']);
    expect(phone.ok).toBe(true);
    if (phone.ok) expect(phone.value.value).toBe('+14155550123');
  });

  it('selects the longest matching allowed calling code', () => {
    const phone = PhoneNumber.parse('+573001234567', ['5', '57']);
    expect(phone.ok).toBe(true);
    if (phone.ok) expect(phone.value.value).toBe('+573001234567');
  });

  it('parses an allowed international number without a plus prefix', () => {
    const phone = PhoneNumber.parse('14155550123', ['1', '14']);
    expect(phone.ok).toBe(true);
    if (phone.ok) expect(phone.value.value).toBe('+14155550123');
  });

  it('compares normalized phone values', () => {
    const local = PhoneNumber.parse('3001234567');
    const e164 = PhoneNumber.parse('+573001234567');
    expect(local.ok && e164.ok && local.value.equals(e164.value)).toBe(true);
  });
});
