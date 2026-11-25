import {
  averageTenths,
  formatTenths,
  nonChronologicalOrder,
  normalizeComment,
  validateScore,
  visibleRating,
  withinRatingWindow,
} from './rating.js';
import {
  approveVerification,
  rejectVerification,
  requestVerification,
  revokeVerification,
  unverified,
} from './verification.js';

const now = new Date('2026-11-25T15:00:00.000Z');
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
const allChecks = { contact_confirmed: true, location_confirmed: true, reference_checked: true };

describe('rating arithmetic', () => {
  it.each([
    // [sum, count, tenths]: averages rounded half up to one decimal, in integers only.
    [5n, 1n, 50n],
    [13n, 3n, 43n], // 4.333… → 4.3
    [14n, 3n, 47n], // 4.666… → 4.7
    [9n, 2n, 45n], // exactly 4.5
    [29n, 8n, 36n], // 3.625 → 3.6 (36.25 tenths round down)
    [3n, 8n, 4n], // 0.375 → 0.4 (3.75 tenths round up)
    [43n, 10n, 43n],
    [87n, 20n, 44n], // 4.35 → 4.4 (half up)
    [83n, 20n, 42n], // 4.15 → 4.2 (half up)
  ])('averages %s over %s as %s tenths', (sum, count, tenths) => {
    expect(averageTenths(sum, count)).toBe(tenths);
  });

  it('formats tenths and hides the average below the minimum', () => {
    expect(formatTenths(43n)).toBe('4.3');
    expect(formatTenths(50n)).toBe('5.0');
    expect(averageTenths(0n, 0n)).toBeNull();
    expect(visibleRating(9n, 2n, 3n)).toBeNull();
    expect(visibleRating(13n, 3n, 3n)).toBe('4.3');
  });

  it('accepts whole scores from 1 to 5 and bounded, trimmed comments', () => {
    expect(validateScore(1)).toBe(1);
    for (const score of [0, 6, 4.5, Number.NaN])
      expect(() => validateScore(score)).toThrow(
        expect.objectContaining({ code: 'invalid_score' }),
      );
    expect(normalizeComment('  Buena  ', 500)).toBe('Buena');
    expect(normalizeComment('   ', 500)).toBeNull();
    expect(normalizeComment(undefined, 500)).toBeNull();
    expect(() => normalizeComment('x'.repeat(11), 10)).toThrow(
      expect.objectContaining({ code: 'comment_too_long' }),
    );
    expect(() => normalizeComment('x', 0)).toThrow(
      expect.objectContaining({ code: 'comment_too_long' }),
    );
  });

  it('opens the rating window at delivery for the configured days', () => {
    expect(withinRatingWindow(now, now, 7)).toBe(true);
    expect(withinRatingWindow(now, days(7), 7)).toBe(true);
    expect(withinRatingWindow(now, new Date(days(7).getTime() + 1), 7)).toBe(false);
    expect(withinRatingWindow(now, days(-1), 7)).toBe(false);
  });

  it('orders comments stably and independently of their creation order', () => {
    const items = [
      '018f47a2-0000-7000-8000-000000000001',
      '018f47a2-0000-7000-8000-000000000002',
      '018f47a2-0000-7000-8000-000000000003',
    ].map((id) => ({ id }));
    const ordered = nonChronologicalOrder(items);
    expect(nonChronologicalOrder([...items].reverse())).toEqual(ordered);
    expect(ordered.map(({ id }) => id).sort()).toEqual(items.map(({ id }) => id));
  });
});

describe('provider verification', () => {
  it('goes unverified → pending → verified → revoked, keeping the note bounded', () => {
    const pending = requestVerification(unverified('p'), '  Finca en Tunja ', now, 7);
    expect(pending).toMatchObject({ status: 'pending', note: 'Finca en Tunja', version: 1 });
    expect(() => requestVerification(pending, null, now, 7)).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
    const verified = approveVerification(pending, allChecks, 'staff', now);
    expect(verified).toMatchObject({ status: 'verified', reviewedBy: 'staff', checks: allChecks });
    const revoked = revokeVerification(verified, 'Quejas confirmadas', 'staff', now);
    expect(revoked).toMatchObject({ status: 'revoked', reason: 'Quejas confirmadas' });
    expect(() => requestVerification(unverified('p'), 'x'.repeat(301), now, 7)).toThrow(
      expect.objectContaining({ code: 'invalid_note' }),
    );
  });

  it('refuses to approve with a missing check and names what is missing', () => {
    const pending = requestVerification(unverified('p'), null, now, 7);
    expect(() =>
      approveVerification(
        pending,
        { contact_confirmed: true, location_confirmed: true },
        'staff',
        now,
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'verification_checks_incomplete',
        details: { missing: ['reference_checked'] },
      }),
    );
    expect(() => approveVerification(unverified('p'), allChecks, 'staff', now)).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it('makes a rejected provider wait for the cooldown before asking again', () => {
    const rejected = rejectVerification(
      requestVerification(unverified('p'), null, now, 7),
      'Sin respuesta',
      'staff',
      now,
    );
    expect(() => rejectVerification(rejected, 'otra vez', 'staff', now)).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
    expect(() => requestVerification(rejected, null, days(6), 7)).toThrow(
      expect.objectContaining({ code: 'verification_cooldown' }),
    );
    expect(requestVerification(rejected, null, days(7), 7).status).toBe('pending');
    expect(() =>
      rejectVerification(requestVerification(unverified('p'), null, now, 7), '  ', 'staff', now),
    ).toThrow(expect.objectContaining({ code: 'reason_required' }));
    expect(() => revokeVerification(rejected, 'x', 'staff', now)).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });
});
