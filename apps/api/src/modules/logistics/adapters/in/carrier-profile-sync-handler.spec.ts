import { createId } from '../../../../shared/kernel/ids.js';
import { CarrierProfileService } from '../../application/carrier-profile.service.js';
import { CarrierProfileSyncHandler } from './carrier-profile-sync-handler.js';

const user = { sub: createId(), role: 'carrier' };
const service = { upsertMine: jest.fn(async () => ({})) };
const handler = new CarrierProfileSyncHandler(service as unknown as CarrierProfileService);
const operation = (overrides: Record<string, unknown> = {}) => ({
  opId: createId(),
  entity: 'carrier_profile',
  entityId: user.sub,
  type: 'update' as const,
  payload: { vehicleType: 'Camión', capacityKg: 2000, plate: 'ABC123' },
  ...overrides,
});

describe('CarrierProfileSyncHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  it('actualiza el perfil propio a través del servicio de aplicación', async () => {
    await expect(handler.handle(user, operation())).resolves.toEqual({ serverVersion: 1 });
    expect(service.upsertMine).toHaveBeenCalledWith(user, operation().payload);
  });

  it('rechaza la modificación del perfil de otro usuario', async () => {
    await expect(handler.handle(user, operation({ entityId: createId() }))).rejects.toMatchObject({
      code: 'invalid_payload',
    });
  });
});
