import {expect} from 'chai';
import Rabbitr = require('../');
import Bluebird = require('bluebird');
import shortId = require('shortid');

const timesAsync = (times: number, fn: (step: number) => PromiseLike<any>) => {
  let step = (n: number) => {
    if (n === times) return;
    return Bluebird.resolve(n).then(fn).then(() => step(n + 1));
  };

  return step(0);
}

describe('rabbitr#destroy', function() {
  it('should be able to destroy an instance with pubsub listeners', function(done) {
    const exchangeName = `${shortId.generate()}.test`;
    const queueName = `${shortId.generate()}.test`;

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });
    rabbit.whenReady(() => {
      rabbit.subscribe(queueName);
      rabbit.bindExchangeToQueue(exchangeName, queueName);
      rabbit.on(exchangeName, ({ack}) => ack());

      setTimeout(function() {
        rabbit.destroy((err) => {
          done(err);
        });
      }, 200);
    });
  });

  it('should be able to destroy an instance with rpc listeners', function(done) {
    const channelName = `${shortId.generate()}.rpc_test`;

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });
    rabbit.whenReady(() => {
      rabbit.rpcListener(channelName, ({ack}) => ack());
      rabbit.rpcExec(channelName, {}, () => void 0);

      setTimeout(function() {
        rabbit.destroy((err) => {
          done(err);
        });
      }, 200);
    });
  });

  it('should be able to destroy a subscription', function() {
    const exchangeName = `${shortId.generate()}.test`;
    const queueName = `${shortId.generate()}.test`;

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });

    return rabbit.whenReady(() => {
      return rabbit.bindExchangeToQueue(exchangeName, queueName)
        .then(() =>
          rabbit.on(exchangeName, ({ack}) => ack())
        ).then(() =>
          rabbit.subscribe(queueName)
        ).then(subscription => {
          expect(Object.keys((rabbit as any).eventListeners)).to.deep.equal([queueName]);
          rabbit.off(exchangeName);
          return subscription.destroy();
        })
        .then(() => {
          expect(Object.keys((rabbit as any).eventListeners)).to.deep.equal([]);
        });
      })
      .finally(() => {
        return rabbit.destroy();
      });
  });

  it('should be able to destroy an rpc subscription', function() {
    const channelName = `${shortId.generate()}.rpc_test`;

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });

    return rabbit.whenReady(() => {
      return rabbit.rpcListener(channelName, ({ack}) => ack({}))
        .then(subscription => {
          return rabbit.rpcExec(channelName, {})
            .then((response) => {
              expect(Object.keys((rabbit as any).eventListeners)).to.deep.equal([channelName]);
              return subscription.destroy();
            })
            .then(() => {
              expect(Object.keys((rabbit as any).eventListeners)).to.deep.equal([]);
            });
        })
        .finally(() => {
          return rabbit.destroy();
        });
    });
  });

  let ifGcIt = global.gc ? it : it.skip;

  ifGcIt(`doesn't leak`, function() {
    function runCycle() {
      const rabbit = new Rabbitr({
        url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
      });
      return rabbit.whenReady(() =>
        Bluebird
          .delay(100)
          .then(() =>
            rabbit.destroy()
          )
          .then(() =>
            global.gc()
          )
      );
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
