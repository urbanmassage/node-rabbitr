import { AbstractBackoff } from './abstractbackoff';

export class Intervals extends AbstractBackoff {
  private retrySchecule: number[];

  constructor(retrySchecule: number[]) {
    super(retrySchecule.length)
    this.retrySchecule = retrySchecule;
  }

  public getWaitTime(retryNumber: number): number {
    return this.retrySchecule[retryNumber - 1];
  }
}
