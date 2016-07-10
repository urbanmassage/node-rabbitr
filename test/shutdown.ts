import Bluebird = require('bluebird');
import Rabbitr = require('../');
import {expect} from 'chai';
import {v4} from 'node-uuid';

describe('shutdown', function() {
  it('should skip rpc after shutdown is triggered', () => {
    const queueName = v4() + '.rpc_test';

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
      log: require('debug')('rabbit1'),
    });
    after(() => rabbit.destroy());

    const rabbit2 = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
      log: require('debug')('rabbit2'),
    });
    after(() => rabbit2.destroy());

    return Bluebird.all([
      rabbit.whenReady(),
      rabbit2.whenReady(),
    ]).then(() =>
      rabbit.rpcListener(queueName, message => {
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
    );
  });
});
