import type { Clock } from '../kernel/clock.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
