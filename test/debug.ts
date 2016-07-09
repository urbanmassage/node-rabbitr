import Rabbitr = require('../');
import {expect} from 'chai';
import {v4} from 'node-uuid';

describe('debug', function() {
  afterEach(() => process.env.RABBITR_DEBUG = '');

  it('should not skip whitelisted rpc', () => {
    const queueName = v4() + '.rpc_test';
    const rpcQueueName = `rpc.${queueName}`;

    process.env.RABBITR_DEBUG = rpcQueueName;

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });

    const response = {test: 1};

    rabbit.rpcListener(queueName, function(message, cb) {
      cb(null, response);
    });

    return rabbit.rpcExec(queueName, {})
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

    rabbit.rpcListener(queueName, function (message, cb) {
      cb(new Error('Got a message on non-whitelisted queue'));
    });

    return rabbit.rpcExec(queueName, {}, { timeout: 50 })
      .then(message => {
        expect.fail('Got a successful response somehow');
      }, err => {
        expect(err).to.be.an.instanceOf(Error);
        expect(err).to.have.property('name').that.equals('TimeoutError');
      });
  });
});
