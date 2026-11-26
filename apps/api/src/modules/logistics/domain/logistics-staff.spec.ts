import { isLogisticsStaff } from './logistics-staff.js';

describe('logistics staff', () => {
  it('includes the operator and the admin, and nobody else', () => {
    expect(['operator', 'admin'].map(isLogisticsStaff)).toEqual([true, true]);
    expect(
      ['finance', 'carrier', 'buyer', 'producer', 'supplier', ''].map(isLogisticsStaff),
    ).toEqual([false, false, false, false, false, false]);
  });
});
