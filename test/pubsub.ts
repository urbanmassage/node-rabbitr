import Rabbitr = require('../');
import {expect} from 'chai';
var uuid = require('uuid');

describe('rabbitr#pubsub', function() {
  const rabbit = new Rabbitr({
    url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
  });
  before((done) => rabbit.whenReady(done));

  it('should receive messages on the specified queue', function(done) {
    var exchangeName = uuid.v4() + '.pubsub_test';
    var queueName = uuid.v4() + '.pubsub_test';

    after(function(done) {
      // cleanup
      rabbit._cachedChannel.deleteExchange(exchangeName);
      rabbit._cachedChannel.deleteQueue(queueName);

      // give rabbit time enough to perform cleanup
      setTimeout(done, 50);
    });

    var testData = {
      testProp: 'pubsub-example-data-' + queueName
    };

    rabbit.subscribe(queueName);
    rabbit.bindExchangeToQueue(exchangeName, queueName, () =>
      rabbit.send(exchangeName, testData)
    );

    rabbit.on(queueName, function(message) {
      message.ack();

      // here we'll assert that the data is the same- the fact we received it means the test has basically passed anyway
      expect(JSON.stringify(testData)).to.equal(JSON.stringify(message.data));

      done();
    });
  });
});
