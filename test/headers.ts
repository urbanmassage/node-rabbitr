import Bluebird = require('bluebird');
import Rabbitr = require('../');
import {expect} from 'chai';
import {v4} from 'node-uuid';

describe('headers', function() {
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
    ]).then(() => rabbit.destroy())
  );

  it('should receive message headers on pupsub', function(done) {
    const exchangeName = v4() + '.pubsub_test';
    const queueName = v4() + '.pubsub_test';

    const testData = {
    };

    const headers = {
      'x-test-header': `pubsub-example-data-${queueName}`
    };

    rabbit.subscribe(queueName)
      .then(() => createdQueues.push(queueName))
      .then(() =>
        rabbit.bindExchangeToQueue(exchangeName, queueName)
          .then(() =>
            createdExchanges.push(exchangeName)
          )
          .then(() =>
            rabbit.send(exchangeName, testData, {headers})
          )
      );

    rabbit.on(queueName, function(message, reply) {
      Bluebird
        .try(() => {
          reply();

          expect(message.data).to.deep.equal(testData);
          expect(message.headers).to.deep.equal(headers);
        })
        .asCallback(done);
    });
  });

  it('should receive message headers on rpc', function() {
    const queueName = v4() + '.rpc_test';

    const headers = {
      'x-test-header': `rpc-example-data-${queueName}`
    };

    const responseHeaders = {
      'x-test-response-header': `rpc-example-data-${queueName}`
    };

    const testData = {
      testProp: 'rpc-example-data-' + queueName
    };
    const responseData = {
      testing: 'return-'+queueName
    };

    return rabbit.rpcListener(queueName, message => {
      expect(message.headers).to.deep.equal(headers);
      expect(message.data).to.deep.equal(testData);

      message.responseHeaders = responseHeaders;

      return Bluebird.resolve(responseData);
    })
      .then(() => createdQueues.push('rpc.' + queueName))
      .then(() =>
        rabbit.rpcExec(queueName, testData, {headers})
          .then(data => {
            expect(data).to.deep.equal(responseData);
          })
      );
  });

});
