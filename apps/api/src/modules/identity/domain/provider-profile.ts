import { DomainError } from '../../../shared/kernel/domain-error.js';
import { isWithinColombia } from '../../../shared/kernel/geo.js';

export interface ProviderProfileProps {
  readonly userId: string;
  readonly displayName: string;
  readonly municipality: string;
  readonly department: string;
  readonly lat: number;
  readonly lng: number;
  readonly description: string;
}

export interface ProviderPublicSummary {
  readonly displayName: string;
  readonly municipality: string;
  readonly department: string;
}

export const validateProviderProfile = (props: ProviderProfileProps): void => {
  if (!isWithinColombia(props.lat, props.lng)) {
    throw new DomainError('Las coordenadas deben estar dentro de Colombia.', 'invalid_coordinates');
  }
  if (props.displayName.trim().length < 2 || props.displayName.length > 100) {
    throw new DomainError(
      'El nombre público debe tener entre 2 y 100 caracteres.',
      'invalid_profile',
    );
  }
  if (
    props.municipality.trim().length < 1 ||
    props.municipality.length > 100 ||
    props.department.trim().length < 1 ||
    props.department.length > 100 ||
    props.description.length > 1000
  ) {
    throw new DomainError('El perfil de proveedor contiene campos inválidos.', 'invalid_profile');
  }
};
