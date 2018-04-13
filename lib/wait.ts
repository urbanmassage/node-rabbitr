import {fromCallback} from 'promise-cb';

export async function wait(timeMS: number) {
  await fromCallback(cb => setTimeout(cb, timeMS));
}
