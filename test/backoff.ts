import Bluebird = require('bluebird');
import Rabbitr = require('../');
import {expect} from 'chai';
import {v4} from 'node-uuid';

describe('rabbitr#backoff', function() {
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

  it('should take at least 1 second to backoff', function(done) {
    this.timeout(60000);

    const exchangeName = v4() + '.backoff_test';
    const queueName = v4() + '.backoff_test';

    const testData = {
      testProp: 'backoff-example-data-' + queueName
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

    let receivedIncrementer = 0;
    let lastReceivedUnixMS = null;

    rabbit.on(queueName, function(message) {
      receivedIncrementer++;

      // here we'll assert that the data is still the same
      expect(JSON.stringify(testData)).to.equal(JSON.stringify(message.data));

      // work out how long ago we last received this message
      const nowUnixMS = new Date().getTime();
      if(lastReceivedUnixMS !== null) {
        // check it was over 1 second ago we last received it
        expect(nowUnixMS - lastReceivedUnixMS).to.be.gt(1000);
      }
      lastReceivedUnixMS = nowUnixMS;

      if(receivedIncrementer < 4) {
        message.reject();
      }
      else {
        message.ack();
        setTimeout(() => {
          done();
        }, 100);
      }
    });
  });
});
