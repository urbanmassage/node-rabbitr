import Rabbitr = require('..');
import { expect } from 'chai';
import { v4 } from 'node-uuid';

describe('rabbitr#pubsub', function() {
  let rabbit: Rabbitr;
  before(() =>
    (
      rabbit = new Rabbitr({
        url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
      })
    )
  );

  const createdExchanges: string[] = [];
  const createdQueues: string[] = [];

  after(() =>
    rabbit.destroy()
  );

  it('should receive messages on the specified queue', function(done) {
    const exchangeName = v4() + '.pubsub_test';
    const queueName = v4() + '.pubsub_test';

    const testData = {
      testProp: 'pubsub-example-data-' + queueName
    };

    rabbit.subscribe([exchangeName], queueName, {}, (message) => {
      message.ack();

      // here we'll assert that the data is the same- the fact we received it means the test has basically passed anyway
      expect(JSON.stringify(testData)).to.equal(JSON.stringify(message.data));
      done();
    })
    .then(() => {
      createdQueues.push(queueName);
      createdExchanges.push(exchangeName);
      setTimeout(() => {rabbit.send(exchangeName, testData)}, 200);
    });
  });

  it('passes Buffers', function(done) {
    const exchangeName = v4() + '.pubsub_buf_test';
    const queueName = v4() + '.pubsub_buf_test';

    const data = 'Hello world!';

    rabbit.subscribe([exchangeName], queueName, {}, (message) => {
      message.ack();

      expect(message.data).to.be.an.instanceOf(Buffer);
      expect(message.data.toString()).to.equal(data);

      done();
    })
    .then(() => {
      createdQueues.push(queueName);
      createdExchanges.push(exchangeName);
      setTimeout(() => {rabbit.send(exchangeName, new Buffer(data))}, 200);
    });
  });
});
