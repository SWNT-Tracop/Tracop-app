import type { UserRole } from '../src/modules/identity/domain/user.js';

/** Showcase accounts: +57 300 000 00NN with NN = 0..30. */
export const SHOWCASE_SIZE = 31;
export const showcasePhone = (index: number): string =>
  `+5730000000${String(index).padStart(2, '0')}`;

/** 0 admin, 1-5 producers, 6-10 suppliers, 11-15 buyers, 16-20 carriers, 21-25 operators, 26-30 finance. */
export const showcaseRole = (index: number): UserRole => {
  if (!Number.isInteger(index) || index < 0 || index >= SHOWCASE_SIZE)
    throw new RangeError(`No showcase account ${index}.`);
  if (index === 0) return 'admin';
  const roles: UserRole[] = ['producer', 'supplier', 'buyer', 'carrier', 'operator', 'finance'];
  return roles[Math.floor((index - 1) / 5)]!;
};
