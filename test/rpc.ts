import Bluebird = require('bluebird');
import Rabbitr = require('../');
import {expect} from 'chai';
import {v4} from 'node-uuid';

describe('rabbitr#rpc', function() {
  let rabbit: Rabbitr;
  before(() =>
    (
      rabbit = new Rabbitr({
        url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
      })
    ).whenReady()
  );

  const createdExchanges: string[] = [];
  const createdQueues: string[] = [];

  after(() =>
    Bluebird.all([
      // cleanup
      ...createdExchanges.map(exchangeName =>
        Bluebird.fromCallback(cb =>
          rabbit._cachedChannel.deleteExchange(exchangeName, {}, cb)
        )
      ),
      ...createdQueues.map(queueName =>
        Bluebird.fromCallback(cb =>
          rabbit._cachedChannel.deleteQueue(queueName, {}, cb)
        )
      ),
      Bluebird.delay(50),
    ]).then(() => rabbit.destroy())
  );

  it('should receive messages on rpcListener', () => {
    const queueName = v4() + '.rpc_test';

    const testData = {
      testProp: 'rpc-example-data-' + queueName
    };
    const responseData = {
      testing: 'return-'+queueName
    };

    return rabbit.rpcListener(queueName, message => {
      // here we'll assert that the data is the same
      expect(message.data).to.deep.equal(testData);

      return Bluebird.resolve(responseData);
    })
      .then(() => createdQueues.push('rpc.' + queueName))
      .then(() =>
        rabbit.rpcExec(queueName, testData)
          .then(data => {
            // here we'll assert that the data is the same -
            // hitting this point basically means the test has passed anyway :)
            expect(data).to.deep.equal(responseData);
          })
      );
  });

  it('passes errors back', () => {
    const queueName = v4() + '.rpc_test';

    const error = new Error('Test');

    return rabbit.rpcListener(queueName, message => {
      return Bluebird.reject(error);
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
            }
          )
      );
  });

  it('passes custom errors', () => {
    const queueName = v4() + '.rpc_test';

    const error = {a: 'b', c: 'd', name: 'Error', message: 'test'};

    return rabbit.rpcListener(queueName, message =>
      Bluebird.reject(error)
    )
      .then(() => createdQueues.push('rpc.' + queueName))
      .then(() =>
        rabbit.rpcExec(queueName, {}).then(
          () => expect.fail(),
          err => {
            expect(err).to.deep.equal(error);
            expect(err).not.to.be.an.instanceOf(Error);
          }
        )
      );
  });

  it('passes Buffers', () => {
    const queueName = v4() + '.rpc_test';

    const data = 'Hello world!';

    rabbit.rpcListener(queueName, message => {
      expect(message.data).to.be.an.instanceOf(Buffer);
      expect(message.data.toString()).to.equal(data);
      return Bluebird.resolve(new Buffer(data));
    })
      .then(() => createdQueues.push('rpc.' + queueName))
      .then(() =>
        rabbit.rpcExec(queueName, new Buffer(data))
          .then(response => {
            expect(response).to.be.an.instanceOf(Buffer);
            expect(response.toString()).to.equal(data);
          })
      );
  });

  it('timeouts', () => {
    const queueName = v4() + '.rpc_test';

    return rabbit.rpcListener(queueName, message => {
      // No reply...
      return new Bluebird(() => {})
    })
      .then(() => createdQueues.push('rpc.' + queueName))
      .then(() =>
        rabbit.rpcExec(queueName, {}, {timeout: 10})
        .then(
          () => expect.fail(),
          err => {
            expect(err).to.be.an.instanceOf(Error);
            expect(err).to.have.property('name').that.equals('TimeoutError');
          }
        )
      );
  });
});
