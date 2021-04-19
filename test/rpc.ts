import Rabbitr = require('../');
import { expect } from 'chai';
import { v4 } from 'node-uuid';
import { wait } from '../lib/wait';

describe('rabbitr#rpc', () => {
  let rabbit: Rabbitr;
  beforeEach(() => {
    rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });
  });

  const createdExchanges: string[] = [];
  const createdQueues: string[] = [];

  afterEach(async () => {
    await Promise.all([
      // cleanup
      ...createdExchanges.map(exchangeName =>
        rabbit._cachedChannel.deleteExchange(exchangeName, {})
      ),
      ...createdQueues.map(queueName =>
        rabbit._cachedChannel.deleteQueue(queueName, {})
      ),
    ]);

    await rabbit.destroy();
  });

  it(`should receive messages on rpcListener`, async () => {
    const queueName = `${v4()}.rpc_test`;

    const testData = {
      testProp: `rpc-example-data-${queueName}`,
    };
    const responseData = {
      testing: `return-${queueName}`,
    };

    rabbit.rpcListener(queueName, {}, async (message) => {
      // here we'll assert that the data is the same
      expect(message.data).to.deep.equal(testData);

      return responseData;
    });

    createdQueues.push(`rpc.${queueName}`);

    const data = await rabbit.rpcExec(queueName, testData)

    expect(data).to.deep.equal(responseData);
  });

  it(`passes Error objects back`, async () => {
    const queueName = `${v4()}.rpc_test`;

    const error = new Error('Test');

    rabbit.rpcListener(queueName, {}, async (message) => {
      throw error;
    });

    createdQueues.push(`rpc.${queueName}`);

    try {
      await rabbit.rpcExec(queueName, {});

      expect.fail(`should have thrown`);
    }
    catch (err) {
      expect(err).to.be.an.instanceOf(Error);

      expect(err.message).to.equal(error.message);

      expect(err).to.have.property('stack').that.has.string((error as any).stack);
    }
  });

  it(`passes custom errors`, async () => {
    const queueName = `${v4()}.rpc_test`;

    const error = {a: 'b', c: 'd', name: 'Error', message: 'test'};

    rabbit.rpcListener(queueName, {}, async (message) => {
      throw error;
    });

    createdQueues.push(`rpc.${queueName}`);

    try {
      await rabbit.rpcExec(queueName, {});
      expect.fail();
    }
    catch (err) {
      expect(err).to.deep.equal(error);
      expect(err).not.to.be.an.instanceOf(Error);
    }
  });

  it(`passes Buffers in requests and responses`, async () => {
    const queueName = `${v4()}.rpc_test`;

    const data = 'Hello world!';

    rabbit.rpcListener(queueName, {}, async (message) => {
      expect(message.data).to.be.an.instanceOf(Buffer);
      expect(message.data.toString()).to.equal(data);
      return new Buffer(data);
    });

    createdQueues.push(`rpc.${queueName}`);

    await wait(200);

    const response = await rabbit.rpcExec(queueName, new Buffer(data));

    expect(response).to.be.an.instanceOf(Buffer);
    expect(response.toString()).to.equal(data);
  });

  it(`throws a TimeoutError on timeout`, async () => {
    const queueName = `${v4()}.rpc_test`;

    rabbit.rpcListener(queueName, {}, async (message) => {
      // No reply...
      await wait(10000);
      return null;
    });

    createdQueues.push(`rpc.${queueName}`);

    try {
      await rabbit.rpcExec(queueName, {}, {timeout: 3});
      expect.fail();
    }
    catch (err) {
      expect(err).to.be.an.instanceOf(Error);
      expect(err).to.have.property('name').that.equals('TimeoutError');
    }
  });
});
