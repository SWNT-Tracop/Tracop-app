import {
  DEFAULT_PREFERENCES,
  NOTIFICATION_KINDS,
  isCritical,
  nextAllowedSendAt,
  planDeliveries,
  retryDelaySeconds,
  validatePreferences,
  type DeliveryChannel,
} from './notification.js';
import { formatCop, orderReference, renderNotification } from './templates.js';

// 2026-11-24 23:30 in Bogotá is 2026-11-25 04:30 UTC.
const lateEvening = new Date('2026-11-25T04:30:00.000Z');
const noon = new Date('2026-11-24T17:00:00.000Z');
const overnight = { start: '22:00', end: '06:00' };
const all = new Set<DeliveryChannel>(['messaging', 'push', 'sms']);

describe('notification preferences', () => {
  it('accepts a full or partial channel order and valid quiet hours', () => {
    expect(
      validatePreferences({ channelOrder: ['push', 'messaging'], quietHours: overnight }),
    ).toEqual({ channelOrder: ['push', 'messaging'], quietHours: overnight });
  });

  it.each([
    [[], null, 'invalid_channel_order'],
    [['messaging', 'messaging'], null, 'invalid_channel_order'],
    [['email'], null, 'invalid_channel_order'],
    [['messaging'], { start: '25:00', end: '06:00' }, 'invalid_quiet_hours'],
    [['messaging'], { start: '06:00', end: '06:00' }, 'invalid_quiet_hours'],
  ])('rejects order %j with quiet hours %j', (channelOrder, quietHours, code) => {
    expect(() =>
      validatePreferences({
        channelOrder: channelOrder as DeliveryChannel[],
        quietHours: quietHours as never,
      }),
    ).toThrow(expect.objectContaining({ code }));
  });
});

describe('quiet hours (America/Bogota)', () => {
  it('sends right away without quiet hours or outside them', () => {
    expect(nextAllowedSendAt(lateEvening, null)).toBe(lateEvening);
    expect(nextAllowedSendAt(noon, overnight)).toBe(noon);
  });

  it('waits until the end of an overnight window, on the next local day', () => {
    // 23:30 local -> 06:00 local next day = 11:00 UTC.
    expect(nextAllowedSendAt(lateEvening, overnight).toISOString()).toBe(
      '2026-11-25T11:00:00.000Z',
    );
    // 05:59 local, same window -> 06:00 local the same day.
    expect(nextAllowedSendAt(new Date('2026-11-25T10:59:00.000Z'), overnight).toISOString()).toBe(
      '2026-11-25T11:00:00.000Z',
    );
    // 06:00 local is already outside.
    const sixAm = new Date('2026-11-25T11:00:00.000Z');
    expect(nextAllowedSendAt(sixAm, overnight)).toBe(sixAm);
  });

  it('handles a window within the same day', () => {
    const lunch = { start: '12:00', end: '14:00' };
    expect(nextAllowedSendAt(noon, lunch).toISOString()).toBe('2026-11-24T19:00:00.000Z');
  });
});

describe('delivery planning', () => {
  it('uses the first reachable enabled channel, recording disabled ones as skipped', () => {
    expect(
      planDeliveries({
        kind: 'delivered',
        preferences: { channelOrder: ['push', 'messaging', 'sms'], quietHours: null },
        reachable: all,
        enabled: new Set(['messaging']),
        now: noon,
      }),
    ).toEqual([
      { channel: 'push', status: 'skipped', nextAttemptAt: null },
      { channel: 'messaging', status: 'pending', nextAttemptAt: noon },
    ]);
  });

  it('only uses SMS for critical notices and skips unreachable channels', () => {
    const plan = (kind: 'delivered' | 'payment_rejected') =>
      planDeliveries({
        kind,
        preferences: DEFAULT_PREFERENCES,
        reachable: new Set(['sms']),
        enabled: all,
        now: noon,
      });
    expect(plan('delivered')).toEqual([]);
    expect(plan('payment_rejected')).toEqual([
      { channel: 'sms', status: 'pending', nextAttemptAt: noon },
    ]);
  });

  it('delays non-critical notices during quiet hours but not critical ones', () => {
    const plan = (kind: 'delivered' | 'incident_opened') =>
      planDeliveries({
        kind,
        preferences: { channelOrder: ['messaging'], quietHours: overnight },
        reachable: all,
        enabled: all,
        now: lateEvening,
      })[0]!.nextAttemptAt!.toISOString();
    expect(plan('delivered')).toBe('2026-11-25T11:00:00.000Z');
    expect(plan('incident_opened')).toBe(lateEvening.toISOString());
    expect(isCritical('incident_opened')).toBe(true);
    expect(isCritical('delivered')).toBe(false);
  });

  it('backs off exponentially up to the cap', () => {
    expect([1, 2, 3, 4, 10].map((attempts) => retryDelaySeconds(attempts, 30, 600))).toEqual([
      30, 60, 120, 240, 600,
    ]);
  });
});

describe('templates', () => {
  it('renders every kind in es-CO without personal data', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const { title, body } = renderNotification(kind, 'es-CO', {
        orderRef: '#01A21018',
        amount: '45.000',
      });
      expect(title.length).toBeGreaterThan(0);
      // Order notices carry the order reference; a price alert carries only the lot's price.
      expect(body).toContain(kind === 'lot_alert' ? '$45.000 COP' : '#01A21018');
    }
  });

  it('falls back to es-CO for an unknown locale', () => {
    expect(renderNotification('in_transit', 'fr-FR', { orderRef: '#1' })).toEqual(
      renderNotification('in_transit', 'es-CO', { orderRef: '#1' }),
    );
  });

  it('shortens order ids and formats COP with dot separators', () => {
    expect(orderReference('01a21018-025b-77c6-9f60-725b833daf62')).toBe('#01A21018');
    expect([0n, 950n, 1_000n, 45_000n, 1_234_567n, -12_500n].map(formatCop)).toEqual([
      '0',
      '950',
      '1.000',
      '45.000',
      '1.234.567',
      '-12.500',
    ]);
    // The largest COP amount the API accepts (19 digits) is grouped in linear time.
    expect(formatCop(9_223_372_036_854_775_807n)).toBe('9.223.372.036.854.775.807');
    expect(renderNotification('settlement_paid', 'es-CO', { orderRef: '#1' }).body).toContain(
      '$0 COP',
    );
  });
});
