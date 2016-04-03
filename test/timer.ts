import {expect} from 'chai';
import Rabbitr = require('../');
import shortId = require('shortid');

const ACCEPTABLE_TIMER_THRESHOLD = 10;

describe('rabbitr#setTimer', function() {
  const rabbit = new Rabbitr({
    url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
  });
  before((done) => rabbit.whenReady(done));

  it('should receive a message after a set number of milliseconds', function(done) {
    const DELAY = 50;

    const queueName = shortId.generate() + '.timer_test';

    after(function(done) {
      // cleanup
      rabbit._cachedChannel.deleteExchange(queueName);
      rabbit._cachedChannel.deleteQueue(queueName);

      // give rabbit time enough to perform cleanup
      setTimeout(done, 50);
    });

    const start = new Date().getTime();

    const testData = {
      testProp: 'timed-example-data-' + queueName
    };

    rabbit.subscribe(queueName);
    rabbit.bindExchangeToQueue(queueName, queueName, function() {
      rabbit.setTimer(queueName, 'unique_id_tester_1', testData, DELAY);
    });

    rabbit.on(queueName, function(message) {
      message.ack();

      // here we'll assert that the data is the same, plus that the time of delivery is at least DELAY give or take kAcceptableTimerThreshold
      const delay = Math.abs(new Date().getTime() - start);
      expect(delay).to.be.above(DELAY - ACCEPTABLE_TIMER_THRESHOLD);
      expect(JSON.stringify(testData)).to.equal(JSON.stringify(message.data));

      done();
    });
  });

  it('should not receive a message if #clearTimer is called', function(done) {
    const DELAY = 50;

    const queueName = shortId.generate() + '.clear_timer_test';

    after(function(done) {
      // cleanup
      rabbit._cachedChannel.deleteExchange(queueName);
      rabbit._cachedChannel.deleteQueue(queueName);

      // give rabbit time enough to perform cleanup
      setTimeout(done, 50);
    });

    const testData = {
      testProp: 'timed-example-data-' + queueName
    };

    let receivedMessages = 0;

    // listen for messages on the queue - nothing should be received here if this works!
    rabbit.subscribe(queueName);
    rabbit.bindExchangeToQueue(queueName, queueName);
    rabbit.on(queueName, function(message) {
      message.ack();

      receivedMessages++;
    });

    // set the timer and schedule the clear
    rabbit.setTimer(queueName, 'unique_clearing_test_id', testData, DELAY);
    setTimeout(function() {
      rabbit.clearTimer(queueName, 'unique_clearing_test_id');
    }, DELAY / 2);

    // also set a timeout to fire after the message should have already have been delivered to check it wasn't
    setTimeout(function() {
      expect(receivedMessages).to.equal(0);

      done();
    }, DELAY);
  });
});
