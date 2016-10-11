import {expect} from 'chai';
import Rabbitr = require('../');
import Bluebird = require('bluebird');
import {v4} from 'node-uuid';

const timesAsync = (times: number, fn: (step: number) => PromiseLike<any>) => {
  let step = (n: number) => {
    if (n === times) return;
    return Bluebird.resolve(n).then(fn).then(() => step(n + 1));
  };

  return step(0);
}

describe('rabbitr#destroy', function() {
  it('should be able to destroy an instance with pubsub listeners', function(done) {
    const exchangeName = v4() + '.test';
    const queueName = v4() + '.test';

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });
    rabbit.whenReady().then(() => {
      rabbit.subscribe(queueName);
      rabbit.bindExchangeToQueue(exchangeName, queueName);
      rabbit.on(exchangeName, () => Bluebird.resolve());

      setTimeout(function() {
        rabbit.destroy().asCallback(done);
      }, 200);
    });
  });

  it('should be able to destroy an instance with rpc listeners', function(done) {
    const channelName = v4() + '.rpc_test';

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });
    rabbit.whenReady().then(() => {
      rabbit.rpcListener(channelName, {}, () => Bluebird.resolve());
      rabbit.rpcExec(channelName, {}, () => void 0);

      setTimeout(function() {
        rabbit.destroy().asCallback(done);
      }, 200);
    });
  });

  let ifGcIt = global.gc && parseFloat(process.version.match(/^v(\d+\.\d+)/)[1]) >= 5 ? it : it.skip;

  ifGcIt('doesn\'t leak', function() {
    function runCycle() {
      const rabbit = new Rabbitr({
        url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
      });

      return new Bluebird((resolve, reject) => {
        rabbit.whenReady()
          .then(() =>
            rabbit.destroy()
          )
          .then(() =>
            global.gc() && void 0
          )
          .delay(100)
          .then(resolve, reject)
          ;
      });
    }

    /** number of times to run a connection cycle */
    let times = 5;

    // run a cycle before so we get accurate measures.
    return timesAsync(times, runCycle).then(() => {
      const {heapUsed} = process.memoryUsage();

      return timesAsync(times, runCycle).then(() => {
        expect(process.memoryUsage().heapUsed).to.be.lessThan(heapUsed * 1.01);
      });
    });
  });
});
