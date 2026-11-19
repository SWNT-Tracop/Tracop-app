export interface OutboxEventInput {
  aggregate: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface OutboxWriter {
  append(events: readonly OutboxEventInput[]): Promise<void>;
}
