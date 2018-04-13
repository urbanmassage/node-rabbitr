import Rabbitr = require('../');
import { expect } from 'chai';
import { v4 } from 'node-uuid';
import { fromCallback } from 'promise-cb';

describe('rabbitr#rpc', function() {
  let rabbit: Rabbitr;
  beforeEach(() =>
    (
      rabbit = new Rabbitr({
        url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
      })
    )
  );

  const createdExchanges: string[] = [];
  const createdQueues: string[] = [];

  afterEach(() =>
    Promise.all([
      // cleanup
      ...createdExchanges.map(exchangeName =>
        rabbit._cachedChannel.deleteExchange(exchangeName, {})
      ),
      ...createdQueues.map(queueName =>
        rabbit._cachedChannel.deleteQueue(queueName, {})
      ),
    ]).then(() => rabbit.destroy())
  );

  it('should receive messages on rpcListener', (done) => {
    const queueName = v4() + '.rpc_test';

    const testData = {
      testProp: 'rpc-example-data-' + queueName
    };
    const responseData = {
      testing: 'return-'+queueName
    };

    rabbit.rpcListener(queueName, {}, async (message) => {
      // here we'll assert that the data is the same
      expect(message.data).to.deep.equal(testData);

      return responseData;
    })
    .then(() => createdQueues.push('rpc.' + queueName))
    .then(() =>
      rabbit.rpcExec(queueName, testData)
        .then(data => {
          // here we'll assert that the data is the same -
          // hitting this point basically means the test has passed anyway :)
          expect(data).to.deep.equal(responseData);
          done();
        })
      );
  });

  it('passes errors back', (done) => {
    const queueName = v4() + '.rpc_test';

    const error = new Error('Test');

    rabbit.rpcListener(queueName, {}, async (message) => {
      throw error;
    })
    .then(() => createdQueues.push('rpc.' + queueName))
    .then(() =>
      rabbit.rpcExec(queueName, {})
        .then(
          () => expect.fail(),
          err => {
            expect(err).to.be.an.instanceOf(Error);
            // bluebird injects some extra props (like __stackCleaned__) so this won't work.
            // expect(err).to.deep.equal(error);

            ['name', 'message'].forEach(function(key) {
              // because these are not checked in deep-equal
              expect(err).to.have.property(key).that.is.deep.equal(error[key]);
            });

            expect(err).to.have.property('stack').that.has.string((error as any).stack);

            done();
          }
        )
      );
  });

  it('passes custom errors', (done) => {
    const queueName = v4() + '.rpc_test';

    const error = {a: 'b', c: 'd', name: 'Error', message: 'test'};

    rabbit.rpcListener(queueName, {}, async (message) => {
      throw error;
    })
    .then(() => createdQueues.push('rpc.' + queueName))
    .then(() =>
      rabbit.rpcExec(queueName, {}).then(
        () => expect.fail(),
        err => {
          expect(err).to.deep.equal(error);
          expect(err).not.to.be.an.instanceOf(Error);
          done();
        }
      )
    );
  });

  it('passes Buffers', (done) => {
    const queueName = v4() + '.rpc_test';

    const data = 'Hello world!';

    rabbit.rpcListener(queueName, {}, async (message) => {
      expect(message.data).to.be.an.instanceOf(Buffer);
      expect(message.data.toString()).to.equal(data);
      return new Buffer(data);
    })
    .then(() => fromCallback(cb => setTimeout(cb, 200)))
    .then(() => {
      createdQueues.push('rpc.' + queueName);

      rabbit.rpcExec(queueName, new Buffer(data))
        .then(response => {
          expect(response).to.be.an.instanceOf(Buffer);
          expect(response.toString()).to.equal(data);
          done();
        });
    });
  });

  it('timeouts', (done) => {
    const queueName = v4() + '.rpc_test';

    rabbit.rpcListener(queueName, {}, async (message) => {
      // No reply...
      await fromCallback(cb => setTimeout(cb, 10000));
      return null;
    });
    createdQueues.push('rpc.' + queueName);

    rabbit.rpcExec(queueName, {}, {timeout: 3})
      .then(
        () => expect.fail(),
        err => {
          expect(err).to.be.an.instanceOf(Error);
          expect(err).to.have.property('name').that.equals('TimeoutError');
          done();
        }
      );
  });
});
