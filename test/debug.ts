import Bluebird = require('bluebird');
import Rabbitr = require('../');
import {expect} from 'chai';
import {v4} from 'node-uuid';

describe.only('debug', function() {
  afterEach(() => process.env.RABBITR_DEBUG = '');

  it('should not skip whitelisted rpc', () => {
    const queueName = v4() + '.rpc_test';
    const rpcQueueName = `rpc.${queueName}`;

    process.env.RABBITR_DEBUG = rpcQueueName;

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });
    after(() => rabbit.destroy());

    const response = {test: 2};

    rabbit.rpcListener(queueName, message => {
      return Bluebird.resolve(response);
    });

    return rabbit.rpcExec(queueName, {test: 1}, {timeout: 100})
      .then(res => {
        expect(res).to.deep.equal(response);
      });
  });

  it('should skip non-whitelisted rpc', () => {
    const queueName = v4() + '.rpc_test';

    process.env.RABBITR_DEBUG = `rpc.test.1234`;

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });
    after(() => rabbit.destroy());

    rabbit.rpcListener(queueName, message => {
      throw new Error('Got a message on non-whitelisted queue');
    });

    return rabbit.rpcExec(queueName, {}, {timeout: 100})
      .then(message => {
        expect.fail(message || true, void 0, 'Got a successful response somehow');
      }, err => {
        expect(err).to.be.an.instanceOf(Error);
        expect(err).to.have.property('name').that.equals('TimeoutError');
      });
  });
});
