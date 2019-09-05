import Rabbitr = require('..');
import { expect } from 'chai';
import { v4 } from 'node-uuid';
import { fromCallback } from 'promise-cb';

describe('debug', function() {
  afterEach(() => process.env.RABBITR_DEBUG = '');

  it('should not skip whitelisted rpc', (done) => {
    const queueName = v4() + '.rpc_test';
    const rpcQueueName = `rpc.${queueName}`;

    process.env.RABBITR_DEBUG = rpcQueueName;

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });

    const response = {test: 2};

    rabbit.rpcListener(queueName, {}, async (message) => {
      return response;
    })
    .then(() => {
      return rabbit.rpcExec(queueName, {test: 1}, {timeout: 1000})
        .then(res => {
          expect(res).to.deep.equal(response);
        })
        .then(() => rabbit.destroy())
        .then(() => done());
    });
  });

  it('should skip non-whitelisted rpc', () => {
    const queueName = v4() + '.rpc_test';

    process.env.RABBITR_DEBUG = `rpc.test.1234`;

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });

    rabbit.rpcListener(queueName, {}, message => {
      throw new Error('Got a message on non-whitelisted queue');
    }).then(() => {
      return rabbit.rpcExec(queueName, {}, {timeout: 100})
        .then(message => {
          expect.fail(message || true, void 0, 'Got a successful response somehow');
        }, err => {
          expect(err).to.be.an.instanceOf(Error);
          expect(err).to.have.property('name').that.equals('TimeoutError');
        })
        .then(() => rabbit.destroy());
    });
  });

  it('should not skip whitelisted pubsub', (done) => {
    const queueName = v4() + '.pubsub_test';

    process.env.RABBITR_DEBUG = queueName;

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });

    const data = {test: 15};

    rabbit.subscribe([queueName], queueName, {}, (message) => {
      expect(message.data).to.deep.equal(data);
      done();
    })
    .then(() => rabbit.send(queueName, data));
  });

  it('should skip non-whitelisted pubsub', (done) => {
    const queueName = v4() + '.pubsub_test';

    process.env.RABBITR_DEBUG = `rpc.test.1234`;

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });

    rabbit.subscribe([queueName], queueName, {}, (message) => {
      throw new Error(`Should not have received message on non-whitelisted queue`);
    })
    .then(() => rabbit.send(queueName, {}));

    setTimeout(done, 300);
  });
});
