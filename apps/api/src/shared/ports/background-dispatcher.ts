export interface BackgroundDispatcher {
  dispatch(task: () => Promise<void>): void;
  flush(timeoutMs?: number): Promise<void>;
}
