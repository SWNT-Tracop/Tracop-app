import { createId } from '../../../../shared/kernel/ids.js';
import { IncidentService } from '../../application/incident.service.js';
import { IncidentSyncHandler } from './incident-sync-handler.js';

const carrier = { sub: createId(), role: 'carrier' };
const handlerService = { open: jest.fn(async () => ({})) };
const handler = new IncidentSyncHandler(handlerService as unknown as IncidentService);
const operation = () => ({
  opId: createId(),
  entity: 'incident',
  entityId: createId(),
  type: 'create' as const,
  payload: {
    orderId: createId(),
    tripId: createId(),
    type: 'retraso',
    description: 'Demora en vía',
  },
});

describe('IncidentSyncHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  it('abre la incidencia mediante el servicio de logística', async () => {
    const input = operation();
    await expect(handler.handle(carrier, input)).resolves.toEqual({ serverVersion: 1 });
    expect(handlerService.open).toHaveBeenCalledWith(carrier, {
      ...input.payload,
      id: input.entityId,
    });
  });

  it('rechaza operaciones distintas a crear', async () => {
    await expect(handler.handle(carrier, { ...operation(), type: 'delete' })).rejects.toMatchObject(
      { code: 'unsupported_transition' },
    );
  });
});
