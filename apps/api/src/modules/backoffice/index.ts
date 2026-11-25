export { BackofficeModule } from './backoffice.module.js';
export { BACKOFFICE_SERVICE } from './application/backoffice-tokens.js';
export type { BackofficeService, ParameterView } from './application/backoffice-service.js';
export { PARAMETER_DEFINITIONS } from './domain/parameters.js';
export {
  METRICS_SOURCES_PORT,
  type BackofficeMetrics,
  type MetricsSourcesPort,
} from './ports/backoffice-ports.js';
