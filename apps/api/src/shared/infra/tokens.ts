export const APP_ENVIRONMENT = Symbol('APP_ENVIRONMENT');
export const APP_LOGGER = Symbol('APP_LOGGER');
export const APP_CLOCK = Symbol('APP_CLOCK');
export const DATABASE = Symbol('DATABASE');
export const DATABASE_POOL = Symbol('DATABASE_POOL');
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
// Declared with its port so application code can inject it without importing infrastructure.
export { OUTBOX_WRITER } from '../ports/outbox-writer.js';
export const BACKGROUND_DISPATCHER = Symbol('BACKGROUND_DISPATCHER');
