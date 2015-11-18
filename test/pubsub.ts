import Rabbitr = require('../');
import {expect} from 'chai';
var uuid = require('uuid');

describe('rabbitr#pubsub', function() {
  let rabbit;
  before(() => rabbit = new Rabbitr({
    url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
  }));

  it('should receive messages on the specified queue', function(done) {
    var queueName = uuid.v4() + '.pubsub_test';

    after(function(done) {
      // cleanup
      rabbit._cachedChannel.deleteExchange(queueName);
      rabbit._cachedChannel.deleteQueue(queueName);

      // give rabbit time enough to perform cleanup
      setTimeout(done, 500);
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

    setTimeout(() => rabbit.send(queueName, testData), 200);
  });

  it('passes Buffers', function(done) {
    const queueName = uuid.v4() + '.pubsub_test';

    const data = 'Hello world!';

    rabbit.subscribe(queueName);
    rabbit.bindExchangeToQueue(queueName, queueName);
    rabbit.on(queueName, function(message, cb) {
      message.ack();

      expect(message.data).to.be.an.instanceOf(Buffer);
      expect(message.data.toString()).to.equal(data);

      done();
    });

    setTimeout(() => rabbit.send(queueName, new Buffer(data)), 200);
  });
});
