import Bluebird = require('bluebird');
import Rabbitr = require('../');
import {expect} from 'chai';
import {v4} from 'uuid';

describe('shutdown', function() {
  it('should skip rpc after shutdown is triggered', () => {
    const queueName = v4() + '.rpc_test';

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
      log: require('debug')('rabbit1'),
    });

    const rabbit2 = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
      log: require('debug')('rabbit2'),
    });

    return Bluebird.all([
      rabbit.whenReady(),
      rabbit2.whenReady(),
    ]).then(() =>
      rabbit.rpcListener(queueName, {}, message => {
        throw new Error('Got a message on non-whitelisted queue');
      })
    ).then(() =>
      (rabbit as any).shutdown()
    ).then(() =>
      rabbit2.rpcExec(queueName, {}, {timeout: 100})
        .then(message => {
          expect.fail(message || true, void 0, 'Got a successful response somehow');
        }, err => {
          expect(err).to.be.an.instanceOf(Error);
          expect(err).to.have.property('name').that.equals('TimeoutError');
        })
    )
    .finally(() =>
      Bluebird.all([
        rabbit.destroy(),
        rabbit2.destroy(),
      ])
    );
  });

  it('should continue handling pending rpc messages after shutdown is triggered', () => {
    const queueName = v4() + '.rpc_test';

    const DELAY = 100;

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
      log: require('debug')('rabbit1'),
    });

    const rabbit2 = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
      log: require('debug')('rabbit2'),
    });

    const expected = {test: 40};

    return Bluebird.all([
      rabbit.whenReady(),
      rabbit2.whenReady(),
    ]).then(() =>
      rabbit.rpcListener(queueName, {}, message => {
        return Bluebird.resolve(expected).delay(DELAY);
      })
    ).then(() =>
      Bluebird.all([
        Bluebird.delay(DELAY/2).then(() => (rabbit as any).shutdown()),
        rabbit2.rpcExec(queueName, {}, {timeout: DELAY + 20})
          .then(response => {
            expect(response).to.deep.equal(expected);
          }),
      ])
    )
    .finally(() =>
      Bluebird.all([
        rabbit.destroy(),
        rabbit2.destroy(),
      ])
    );
  });
});
