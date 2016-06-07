import Rabbitr = require('../');
import {expect} from 'chai';
import {v4} from 'node-uuid';

describe('rabbitr#pubsub', function() {
  const rabbit = new Rabbitr({
    url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
  });
  before((done) => rabbit.whenReady(done));

  it('should receive messages on the specified queue', function(done) {
    const exchangeName = v4() + '.pubsub_test';
    const queueName = v4() + '.pubsub_test';

    after(function(done) {
      // cleanup
      rabbit._cachedChannel.deleteExchange(exchangeName);
      rabbit._cachedChannel.deleteQueue(queueName);

      // give rabbit time enough to perform cleanup
      setTimeout(done, 50);
    });

    const testData = {
      testProp: 'pubsub-example-data-' + queueName
    };

    rabbit.subscribe(queueName);
    rabbit.bindExchangeToQueue(exchangeName, queueName, () =>
      rabbit.send(exchangeName, testData, () => void 0)
    );

    rabbit.on(queueName, function(message) {
      message.ack();

      // here we'll assert that the data is the same- the fact we received it means the test has basically passed anyway
      expect(JSON.stringify(testData)).to.equal(JSON.stringify(message.data));

      done();
    });
  });

  it('passes Buffers', function(done) {
    const exchangeName = v4() + '.pubsub_buf_test';
    const queueName = v4() + '.pubsub_buf_test';

    after(function(done) {
      // cleanup
      rabbit._cachedChannel.deleteExchange(exchangeName);
      rabbit._cachedChannel.deleteQueue(queueName);

      // give rabbit time enough to perform cleanup
      setTimeout(done, 50);
    });

    const data = 'Hello world!';

    rabbit.subscribe(queueName);
    rabbit.bindExchangeToQueue(exchangeName, queueName, () =>
      rabbit.send(exchangeName, new Buffer(data), () => void 0)
    );

    rabbit.on(queueName, function(message) {
      message.ack();

      expect(message.data).to.be.an.instanceOf(Buffer);
      expect(message.data.toString()).to.equal(data);

      done();
    });
  });
});
