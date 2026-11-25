import { PARAMETER_KEYS } from '../../../shared/kernel/parameter-keys.js';
import { PARAMETER_DEFINITIONS, isParameterKey, parseParameterValue } from './parameters.js';

describe('parameter registry', () => {
  it('defines every key, all still PROVISIONAL (AGENTS §23)', () => {
    for (const key of PARAMETER_KEYS) {
      expect(PARAMETER_DEFINITIONS[key]).toMatchObject({ key, provisional: true });
      expect(PARAMETER_DEFINITIONS[key].min).toBeLessThan(PARAMETER_DEFINITIONS[key].max);
    }
    expect(isParameterKey('order.commission_rate_bps')).toBe(true);
    expect(isParameterKey('order.unknown')).toBe(false);
  });

  it('parses integer strings within range', () => {
    expect(parseParameterValue('order.commission_rate_bps', '0')).toBe(0n);
    expect(parseParameterValue('order.commission_rate_bps', '10000')).toBe(10_000n);
    expect(parseParameterValue('order.freight_cop', '9223372036854775807')).toBe(
      9_223_372_036_854_775_807n,
    );
  });

  it.each([
    ['order.commission_rate_bps', '10001', 'parameter_out_of_range'],
    ['order.quote_ttl_hours', '0', 'parameter_out_of_range'],
    ['payment.rejection_grace_hours', '169', 'parameter_out_of_range'],
    ['order.freight_cop', '-1', 'parameter_out_of_range'],
    ['order.freight_cop', '1.5', 'invalid_parameter_value'],
    ['order.freight_cop', '007', 'invalid_parameter_value'],
  ] as const)('refuses %s = %s', (key, value, code) => {
    expect(() => parseParameterValue(key, value)).toThrow(expect.objectContaining({ code }));
  });
});
