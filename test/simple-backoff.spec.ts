import Rabbitr = require('../');
import { expect } from 'chai';
import { v4 } from 'node-uuid';
import {SimpleBackoff} from '../backoff/simple-backoff'

describe('rabbitr#simple-backoff', function() {
  let rabbit: Rabbitr;
  let backoff = new SimpleBackoff([5,10,20])

  before(() =>
    (
      rabbit = new Rabbitr({
        url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
        backoffLogic: backoff
      })
    )
  );

  const createdExchanges: string[] = [];
  const createdQueues: string[] = [];

  after(() =>
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

  it('should wait the amount of times specified in the backoff config', function(done) {
    this.timeout(60000);

    const exchangeName = v4() + '.simple_backoff_test';
    const queueName = v4() + '.simple_backoff_test';

    const testData = {
      testProp: 'backoff-example-data-' + queueName
    };

    let receivedIncrementer = 0;
    let lastReceivedUnixMS = null;

    rabbit.subscribe([exchangeName], queueName, {}, (message) => {
      receivedIncrementer++;

      expect(JSON.stringify(testData)).to.equal(JSON.stringify(message.data));

      const nowUnixMS = new Date().getTime();
      if(lastReceivedUnixMS !== null) {
        console.log(nowUnixMS - lastReceivedUnixMS)
        expect(nowUnixMS - lastReceivedUnixMS).to.be.gt(backoff.getWaitTime(receivedIncrementer-1));
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
    createdQueues.push(queueName);
    createdExchanges.push(exchangeName);

    setTimeout(() => {rabbit.send(exchangeName, testData)}, 200);
  });
});
