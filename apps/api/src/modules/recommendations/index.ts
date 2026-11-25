export { RecommendationsModule } from './recommendations.module.js';
export {
  RECOMMENDATIONS_OUTBOX_SUBSCRIBERS,
  RECOMMENDATIONS_SERVICE,
} from './application/recommendations-tokens.js';
export { DANE_CITATION } from './application/recommendations-service.js';
export type {
  RecommendationsService,
  SuggestionView,
} from './application/recommendations-service.js';
export {
  CATALOG_FACTS_PORT,
  ORDER_FACTS_PORT,
  PROVIDER_VERIFICATION_PORT,
  RECOMMENDATIONS_CLOCK,
} from './ports/recommendations-ports.js';
export type {
  AcceptedOrderFacts,
  AvailableLot,
  CatalogFactsPort,
  OrderFactsPort,
  ProviderVerificationPort,
} from './ports/recommendations-ports.js';
export type { PublishedLotFacts } from './domain/alerts.js';
