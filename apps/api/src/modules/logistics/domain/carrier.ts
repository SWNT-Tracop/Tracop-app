import { DomainError } from '../../../shared/kernel/domain-error.js';

export interface CarrierProps {
  readonly userId: string;
  readonly vehicleType: string;
  readonly capacityKg: number;
  readonly plate: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class Carrier {
  private constructor(readonly props: CarrierProps) {}

  static create(props: CarrierProps): Carrier {
    const vehicleType = props.vehicleType.trim();
    const plate = props.plate.trim().toUpperCase();
    if (vehicleType.length < 2 || vehicleType.length > 40)
      throw new DomainError('Tipo de vehículo inválido.', 'invalid_vehicle_type');
    if (!/^[A-Z0-9-]{3,12}$/.test(plate)) throw new DomainError('Placa inválida.', 'invalid_plate');
    if (!Number.isInteger(props.capacityKg) || props.capacityKg < 1 || props.capacityKg > 100_000)
      throw new DomainError('Capacidad inválida.', 'invalid_capacity');
    return new Carrier({ ...props, vehicleType, plate });
  }

  static reconstitute(props: CarrierProps): Carrier {
    return new Carrier({ ...props });
  }
}
