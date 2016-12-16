import Bluebird = require('bluebird');
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

    const response = {test: 2};

    rabbit.rpcListener(queueName, {}, message => {
      return Bluebird.resolve(response);
    });

    return rabbit.rpcExec(queueName, {test: 1}, {timeout: 100})
      .then(res => {
        expect(res).to.deep.equal(response);
      })
      .finally(() => rabbit.destroy());
  });

  it('should skip non-whitelisted rpc', () => {
    const queueName = v4() + '.rpc_test';

    process.env.RABBITR_DEBUG = `rpc.test.1234`;

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });

    rabbit.rpcListener(queueName, {}, message => {
      throw new Error('Got a message on non-whitelisted queue');
    });

    return rabbit.rpcExec(queueName, {}, {timeout: 100})
      .then(message => {
        expect.fail(message || true, void 0, 'Got a successful response somehow');
      }, err => {
        expect(err).to.be.an.instanceOf(Error);
        expect(err).to.have.property('name').that.equals('TimeoutError');
      })
      .finally(() => rabbit.destroy());
  });

  it('should not skip whitelisted pubsub', () => {
    const queueName = v4() + '.pubsub_test';

    process.env.RABBITR_DEBUG = queueName;

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });

    const data = {test: 15};

    return Bluebird.all([
      rabbit.subscribe(queueName),
      rabbit.bindExchangeToQueue(queueName, queueName),
    ]).then(() =>
      Bluebird.all([
        new Bluebird<any>(resolve => {
          rabbit.on(queueName, resolve);
        }).then(message => {
          expect(message.data).to.deep.equal(data);
        }),
        rabbit.send(queueName, data),
      ])
    )
    .finally(() => rabbit.destroy());
  });

  it('should skip non-whitelisted pubsub', () => {
    const queueName = v4() + '.pubsub_test';

    process.env.RABBITR_DEBUG = `rpc.test.1234`;

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });

    return Bluebird.all([
      rabbit.subscribe(queueName),
      rabbit.bindExchangeToQueue(queueName, queueName),
    ]).then(() =>
      Bluebird.all([
        Bluebird.race([
          new Bluebird<any>((resolve, reject) => {
            rabbit.on(queueName, reject);
          }),
          Bluebird.delay(100),
        ]),
        rabbit.send(queueName, {}),
      ])
    )
    .finally(() => rabbit.destroy());
  });
});
