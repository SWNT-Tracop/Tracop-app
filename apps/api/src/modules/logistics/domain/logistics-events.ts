export type LogisticsEventType =
  | 'TripPlanned'
  | 'TripAssigned'
  | 'TripStarted'
  | 'PickupConfirmed'
  | 'DeliveryConfirmed'
  | 'TripCompleted'
  | 'TripCancelled'
  | 'IncidentOpened'
  | 'IncidentResolved';

export interface LogisticsEvent {
  readonly type: LogisticsEventType;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}
