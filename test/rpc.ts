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
        rabbit._cachedChannel?.deleteExchange(exchangeName, {})
      ),
      ...createdQueues.map(queueName =>
        rabbit._cachedChannel?.deleteQueue(queueName, {})
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

    await rabbit.rpcListener(queueName, {}, async (message: any) => {
      // here we'll assert that the data is the same
      expect(message.data).to.deep.equal(testData);

      return responseData;
    });

    createdQueues.push(`rpc.${queueName}`);

    const data = await rabbit.rpcExec(queueName, testData)

    expect(data).to.deep.equal(responseData);
  });

  it(`should pass the context object through`, async () => {
    const queueName = `${v4()}.rpc_test`;

    const testContext = {
      testProp: `rpc-example-context-${queueName}`,
    };

    await rabbit.rpcListener(queueName, {}, async (message: any) => {
      // here we'll assert that the context data is the same
      expect(message.context).to.deep.equal(testContext);

      return {};
    });

    createdQueues.push(`rpc.${queueName}`);

    const data = await rabbit.rpcExec(queueName, {}, {
      context: testContext,
    });
  });

  it(`passes Error objects back`, async () => {
    const queueName = `${v4()}.rpc_test`;

    const error = new Error('Test');

    await rabbit.rpcListener(queueName, {}, async (message: any) => {
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

    await rabbit.rpcListener(queueName, {}, async (message: unknown) => {
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

    await rabbit.rpcListener(queueName, {}, async (message: any) => {
      expect(message.data).to.be.an.instanceOf(Buffer);
      expect(message.data.toString()).to.equal(data);
      return Buffer.from(data);
    });

    createdQueues.push(`rpc.${queueName}`);

    await wait(200);

    const response = await rabbit.rpcExec(queueName, Buffer.from(data));

    expect(response).to.be.an.instanceOf(Buffer);
    expect(response.toString()).to.equal(data);
  });

  it(`throws a TimeoutError on timeout`, async () => {
    const queueName = `${v4()}.rpc_test`;

    await rabbit.rpcListener(queueName, {}, async (message: unknown) => {
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
