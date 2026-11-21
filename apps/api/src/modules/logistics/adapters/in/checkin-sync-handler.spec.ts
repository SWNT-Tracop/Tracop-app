import { createId } from '../../../../shared/kernel/ids.js';
import { CheckinService } from '../../application/checkin.service.js';
import { CheckinSyncHandler } from './checkin-sync-handler.js';

const now = new Date('2026-11-19T12:00:00.000Z');
const carrier = { sub: createId(), role: 'carrier' };
const stopId = createId();

const operation = (overrides: Record<string, unknown> = {}) => ({
  opId: createId(),
  entity: 'checkin',
  entityId: createId(),
  type: 'create' as const,
  payload: { stopId, kind: 'pickup', clientAt: now.toISOString() },
  baseVersion: 1,
  ...overrides,
});

describe('CheckinSyncHandler', () => {
  const service = {
    record: jest.fn(async () => ({ id: createId() })),
    getTripVersion: jest.fn(async () => 2),
  };
  const handler = new CheckinSyncHandler(service as unknown as CheckinService);

  beforeEach(() => jest.clearAllMocks());

  it('registra el check-in y devuelve la versión del servidor', async () => {
    const result = await handler.handle(carrier, operation());
    expect(result).toEqual({ serverVersion: 2 });
    expect(service.record).toHaveBeenCalledWith(
      carrier,
      expect.objectContaining({ stopId, kind: 'pickup' }),
      1,
    );
  });

  it('acepta update con mediaRef y rechaza operaciones no soportadas', async () => {
    await handler.handle(
      carrier,
      operation({
        type: 'update',
        payload: { stopId, kind: 'delivery', clientAt: now.toISOString(), mediaRef: 'photos/x' },
      }),
    );
    expect(service.record).toHaveBeenCalledWith(
      carrier,
      expect.objectContaining({ mediaRef: 'photos/x' }),
      1,
    );
    await expect(handler.handle(carrier, operation({ type: 'delete' }))).rejects.toMatchObject({
      code: 'unsupported_transition',
    });
    await expect(handler.handle(carrier, operation({ type: 'transition' }))).rejects.toMatchObject({
      code: 'unsupported_transition',
    });
  });

  it('rechaza payload inválido y baseVersion ausente', async () => {
    await expect(
      handler.handle(carrier, operation({ baseVersion: undefined })),
    ).rejects.toMatchObject({
      code: 'invalid_payload',
    });
    await expect(
      handler.handle(carrier, operation({ payload: { stopId, kind: 'pickup' } })),
    ).rejects.toThrow();
  });
});
