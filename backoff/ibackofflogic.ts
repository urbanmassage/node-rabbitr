export interface IBackoffLogic {
  getWaitTime(retryNumber: number): number;
  shouldRetry(retryNumber: number): boolean;
}
