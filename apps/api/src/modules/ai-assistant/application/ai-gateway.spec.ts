import { z } from 'zod';
import { FakeLLMAdapter, fakeJson } from '../adapters/out/fake-llm.adapter.js';
import type { AiConsentPort, UsageRecord, UsageRepository } from '../ports/assistant-ports.js';
import { AiGateway, MinuteRateLimiter, type AiGatewaySettings } from './ai-gateway.js';

class Clock {
  constructor(public current = new Date('2026-11-25T15:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
}

class MemoryUsage implements UsageRepository {
  readonly records: UsageRecord[] = [];
  used = 0;
  reserved = 0;
  async record(usage: UsageRecord) {
    this.records.push(usage);
  }
  async countForDay(userId: string) {
    return this.records.filter((r) => r.userId === userId && r.outcome !== 'budget_exhausted')
      .length;
  }
  async reserve(_month: string, tokens: number, cap: number) {
    if (this.used + this.reserved + tokens > cap) return false;
    this.reserved += tokens;
    return true;
  }
  async settle(_month: string, reserved: number, used: number) {
    this.reserved -= reserved;
    this.used += used;
  }
  async purgeBefore() {
    return 0;
  }
}

const consent = (status: 'accepted' | 'none'): AiConsentPort => ({
  status: async () => status,
  accept: async () => undefined,
  withdraw: async () => undefined,
});

const settings: AiGatewaySettings = {
  enabled: true,
  consentVersion: 'v1',
  dailyRequestsPerUser: 3,
  requestsPerMinute: 2,
  monthlyTokenCap: 100_000,
  maxOutputTokens: 100,
};
const schema = z.object({ value: z.string() }).strict();
const request = { system: 's', user: 'u', jsonSchema: {} };

const gateway = (
  overrides: Partial<AiGatewaySettings> = {},
  status: 'accepted' | 'none' = 'accepted',
) => {
  const clock = new Clock();
  const llm = new FakeLLMAdapter(() => fakeJson({ value: 'ok' }, 50, 10));
  const usage = new MemoryUsage();
  const all = { ...settings, ...overrides };
  return {
    clock,
    llm,
    usage,
    ai: new AiGateway(
      llm,
      consent(status),
      usage,
      new MinuteRateLimiter(all.requestsPerMinute, clock),
      all,
      clock,
    ),
  };
};

describe('AiGateway', () => {
  it('does nothing when AI is disabled or the user has not consented', async () => {
    for (const [overrides, status, reason] of [
      [{ enabled: false }, 'accepted', 'disabled'],
      [{}, 'none', 'no_consent'],
    ] as const) {
      const { ai, llm } = gateway(overrides, status);
      expect(await ai.generate('u1', 'extract', request, schema)).toEqual({
        kind: 'unavailable',
        reason,
      });
      expect(llm.requests).toHaveLength(0);
    }
  });

  it('limits calls per minute in memory and per day in the usage table', async () => {
    const { ai, clock, llm } = gateway({ requestsPerMinute: 2, dailyRequestsPerUser: 3 });
    expect((await ai.generate('u1', 'extract', request, schema)).kind).toBe('ok');
    expect((await ai.generate('u1', 'extract', request, schema)).kind).toBe('ok');
    expect(await ai.generate('u1', 'extract', request, schema)).toEqual({
      kind: 'unavailable',
      reason: 'rate_limited',
    });
    // Another user has their own minute.
    expect((await ai.generate('u2', 'extract', request, schema)).kind).toBe('ok');
    clock.current = new Date(clock.current.getTime() + 60_000);
    expect((await ai.generate('u1', 'extract', request, schema)).kind).toBe('ok');
    clock.current = new Date(clock.current.getTime() + 60_000);
    expect(await ai.generate('u1', 'extract', request, schema)).toEqual({
      kind: 'unavailable',
      reason: 'daily_limit',
    });
    expect(llm.requests).toHaveLength(4);
  });

  it('retries an invalid output once, then gives up; records tokens and outcomes, not content', async () => {
    const { ai, llm, usage } = gateway();
    llm.respondWith(() => fakeJson({ value: 'ok', extra: true }));
    expect(await ai.generate('u1', 'extract', request, schema)).toEqual({
      kind: 'unavailable',
      reason: 'model_failed',
    });
    expect(llm.requests).toHaveLength(2);
    expect(usage.records.map(({ outcome }) => outcome)).toEqual([
      'invalid_output',
      'invalid_output',
    ]);
    expect(Object.keys(usage.records[0]!).sort()).toEqual(
      [
        'at',
        'id',
        'inputTokens',
        'latencyMs',
        'outcome',
        'outputTokens',
        'purpose',
        'userId',
      ].sort(),
    );
  });

  it('does not retry a failed provider call and settles every reservation', async () => {
    const { ai, llm, usage } = gateway();
    llm.respondWith(() => ({ kind: 'error', reason: 'timeout', inputTokens: 0, outputTokens: 0 }));
    expect(await ai.generate('u1', 'extract', request, schema)).toEqual({
      kind: 'unavailable',
      reason: 'model_failed',
    });
    expect(llm.requests).toHaveLength(1);
    expect(usage.reserved).toBe(0);
  });

  it('stops at the monthly cap before calling the model', async () => {
    const { ai, llm, usage } = gateway({ monthlyTokenCap: 50 });
    expect(await ai.generate('u1', 'extract', request, schema)).toEqual({
      kind: 'unavailable',
      reason: 'budget_exhausted',
    });
    expect(llm.requests).toHaveLength(0);
    expect(usage.records.map(({ outcome }) => outcome)).toEqual(['budget_exhausted']);
  });
});
