import { fromCallback } from 'promise-cb';

let promise: Promise<void> = null;

async function promiseFunc() {
  await fromCallback(cb => setTimeout(cb, 1500));
  return null;
}

async function setup() {
  promise = promiseFunc();
}

async function run() {
  console.time('run');
  await promise;
  console.timeEnd('run');
}

setup().then(() => {
  console.log('complete setup');
  return run().then(() => {
    console.log('complete 1');
    return run().then(() => {
      console.log('complete 2');
    });
  });
});
