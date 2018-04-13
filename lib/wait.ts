import {fromCallback} from 'promise-cb';

export function wait(timeMS: number): Promise<void> {
  return fromCallback(cb => setTimeout(cb, timeMS));
}
