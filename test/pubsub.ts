import Bluebird = require('bluebird');
import Rabbitr = require('../');
import {expect} from 'chai';
import {v4} from 'node-uuid';

describe('rabbitr#pubsub', function() {
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

  it('should receive messages on the specified queue', function(done) {
    const exchangeName = v4() + '.pubsub_test';
    const queueName = v4() + '.pubsub_test';

    const testData = {
      testProp: 'pubsub-example-data-' + queueName
    };

    rabbit.subscribe(queueName)
      .then(() => createdQueues.push(queueName))
      .then(() =>
        rabbit.bindExchangeToQueue(exchangeName, queueName)
          .then(() =>
            createdExchanges.push(exchangeName)
          )
          .then(() =>
            rabbit.send(exchangeName, testData)
          )
      );

    rabbit.on(queueName, function(message) {
      Bluebird
        .try(() => {
          message.ack();

          // here we'll assert that the data is the same- the fact we received it means the test has basically passed anyway
          expect(JSON.stringify(testData)).to.equal(JSON.stringify(message.data));
        })
        .asCallback(done);
    });
  });

  it('passes Buffers', function(done) {
    const exchangeName = v4() + '.pubsub_buf_test';
    const queueName = v4() + '.pubsub_buf_test';

    const data = 'Hello world!';

    rabbit.subscribe(queueName)
      .then(() => createdQueues.push(queueName))
      .then(() =>
        rabbit.bindExchangeToQueue(exchangeName, queueName)
          .then(() =>
            createdExchanges.push(exchangeName)
          )
          .then(() =>
            rabbit.send(exchangeName, new Buffer(data))
          )
      );

    rabbit.on(queueName, function(message) {
      Bluebird
        .try(() => {
          message.ack();

          expect(message.data).to.be.an.instanceOf(Buffer);
          expect(message.data.toString()).to.equal(data);
        })
        .asCallback(done);
    });
  });
});
