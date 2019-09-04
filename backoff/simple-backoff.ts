import {IBackoffLogic} from './ibackofflogic'

export class SimpleBackoff implements IBackoffLogic {
  private retrySchecule: number[];

  constructor(retrySchecule: number[]) {
    this.retrySchecule = retrySchecule;
  }

  public getWaitTime(retryNumber: number): number {
    return this.retrySchecule[retryNumber - 1];
  }

  public shouldRetry(retryNumber: number): boolean {
    return retryNumber <= this.retrySchecule.length;
  }
}
