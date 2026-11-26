import { PhoneNumber } from '../src/modules/identity/domain/phone-number.js';
import { SHOWCASE_SIZE, showcasePhone, showcaseRole } from '../scripts/showcase-plan.js';

describe('showcase plan', () => {
  it('maps the 31 numbers to the roles the team asked for', () => {
    const roles = Array.from({ length: SHOWCASE_SIZE }, (_, i) => showcaseRole(i));
    const count = (role: string) => roles.filter((item) => item === role).length;
    expect(roles[0]).toBe('admin');
    expect(roles.slice(1, 6)).toEqual(Array(5).fill('producer'));
    expect(roles.slice(26, 31)).toEqual(Array(5).fill('finance'));
    expect(['producer', 'supplier', 'buyer', 'carrier', 'operator', 'finance'].map(count)).toEqual([
      5, 5, 5, 5, 5, 5,
    ]);
    expect(() => showcaseRole(31)).toThrow(RangeError);
  });

  it('uses valid, distinct Colombian numbers from 300 000 0000 to 300 000 0030', () => {
    const phones = Array.from({ length: SHOWCASE_SIZE }, (_, i) => showcasePhone(i));
    expect(new Set(phones).size).toBe(SHOWCASE_SIZE);
    expect(phones[0]).toBe('+573000000000');
    expect(phones[30]).toBe('+573000000030');
    for (const phone of phones) expect(PhoneNumber.parse(phone).ok).toBe(true);
  });
});
