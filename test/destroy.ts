import { expect } from 'chai';
import Rabbitr = require('../');
import { v4 } from 'node-uuid';
import { fromCallback } from 'promise-cb';
import { wait } from '../lib/wait';

const timesAsync = (times: number, fn: (step: number) => PromiseLike<any>) => {
  // @ts-ignore
  let step = (n: number) => {
    if (n === times) return;
    return Promise.resolve(n).then(fn).then(() => step(n + 1));
  };

  return step(0);
}

describe('rabbitr#destroy', () => {
  it('should be able to destroy an instance with pubsub listeners', async () => {
    const exchangeName = v4() + '.test';
    const queueName = v4() + '.test';

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });

    rabbit.subscribe([exchangeName], queueName, {}, ({ack}) => ack());

    await wait(200);

    await rabbit.destroy();
  });

  it('should be able to destroy an instance with rpc listeners', async () => {
    const channelName = v4() + '.rpc_test';

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });

    rabbit.rpcListener(channelName, {}, () => { return null; });
    rabbit.rpcExec(channelName, { test: 'data' }, {});

    await wait(200);

    await rabbit.destroy();
  });

  // @ts-ignore
  let ifGcIt = global.gc && parseFloat(process.version.match(/^v(\d+\.\d+)/)[1]) >= 5 ? it : it.skip;

  ifGcIt('doesn\'t leak', function(done) {
    this.timeout(20000);

    async function runCycle() {
      const rabbit = new Rabbitr({
        url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
      });

      await wait(200);

      await rabbit.destroy();

      await wait(200);
    }

    /** number of times to run a connection cycle */
    let times = 5;

    // run a cycle before so we get accurate measures.
    timesAsync(times, runCycle).then(() => {
      const {heapUsed} = process.memoryUsage();

      return timesAsync(times, runCycle).then(() => {
        expect(process.memoryUsage().heapUsed).to.be.lessThan(heapUsed * 1.1);
        done();
      });
    });
  });
});
