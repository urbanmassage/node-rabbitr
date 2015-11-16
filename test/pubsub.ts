import Rabbitr = require('../lib/rabbitr');
import {expect} from 'chai';
var uuid = require('uuid');

describe('rabbitr#pubsub', function() {
  it('should receive messages on the specified queue', function(done) {
    this.timeout(5000);

    var queueName = uuid.v4() + '.pubsub_test';

    after(function(done) {
      // cleanup
      rabbit._cachedChannel.deleteExchange(queueName);
      rabbit._cachedChannel.deleteQueue(queueName);

      // give rabbit time enough to perform cleanup
      setTimeout(done, 500);
    });

    var rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });

    var testData = {
      testProp: 'pubsub-example-data-' + queueName
    };

    rabbit.subscribe(queueName);
    rabbit.bindExchangeToQueue(queueName, queueName);
    rabbit.on(queueName, function(message) {
      message.ack();

      // here we'll assert that the data is the same- the fact we received it means the test has basically passed anyway
      expect(JSON.stringify(testData)).to.equal(JSON.stringify(message.data));

      done();
    });

    setTimeout(function() {
      rabbit.send(queueName, testData);
    }, 1000);
  });
});