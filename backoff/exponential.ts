import {AbstractBackoff} from './abstractbackoff'

export class Exponential extends AbstractBackoff{
  private multiplier:number;

  constructor(multiplier:number, maxAttempts:number){
    super(maxAttempts)
    this.multiplier = multiplier
  }

  public getWaitTime(retryNumber: number): number {
    const exp = Math.pow(2, retryNumber);
    return Math.round(exp * this.multiplier)
  }
}
