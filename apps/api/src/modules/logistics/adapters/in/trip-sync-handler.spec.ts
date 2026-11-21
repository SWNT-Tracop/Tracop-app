import { createId } from '../../../../shared/kernel/ids.js';
import { TripPlanningService } from '../../application/trip-planning.service.js';
import { TripSyncHandler } from './trip-sync-handler.js';

const carrier = { sub: createId(), role: 'carrier' };
const tripId = createId();
const trips = {
  createTrip: jest.fn(async () => ({ version: 2 })),
  start: jest.fn(async () => ({ version: 3 })),
};
const handler = new TripSyncHandler(trips as unknown as TripPlanningService);
const operation = (overrides: Record<string, unknown> = {}) => ({
  opId: createId(),
  entity: 'trip',
  entityId: tripId,
  type: 'create' as const,
  payload: { orderIds: [createId()] },
  ...overrides,
});

describe('TripSyncHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  it('crea el viaje desde una operación offline', async () => {
    await expect(handler.handle(carrier, operation())).resolves.toEqual({ serverVersion: 2 });
    expect(trips.createTrip).toHaveBeenCalledWith(carrier, {
      id: tripId,
      orderIds: expect.any(Array),
    });
  });

  it('inicia viajes con versión base y rechaza transiciones desconocidas', async () => {
    await expect(
      handler.handle(
        carrier,
        operation({
          type: 'transition',
          baseVersion: 2,
          payload: { action: 'start' },
        }),
      ),
    ).resolves.toEqual({ serverVersion: 3 });
    expect(trips.start).toHaveBeenCalledWith(carrier, tripId, 2);
    await expect(handler.handle(carrier, operation({ type: 'delete' }))).rejects.toMatchObject({
      code: 'unsupported_transition',
    });
  });
});
