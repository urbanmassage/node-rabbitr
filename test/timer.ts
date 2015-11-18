var uuid = require('uuid');
var expect = require('chai').expect;
var Rabbitr = require('../');

var kAcceptableTimerThreshold = 500;

describe('rabbitr#setTimer', function() {
  const rabbit = new Rabbitr({
    url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
  });
  before((done) => rabbit.whenReady(done));

  it('should receive a message after a set number of milliseconds', function(done) {
    this.timeout(10000);

    var queueName = uuid.v4() + '.timer_test';

    after(function(done) {
      // cleanup
      rabbit._cachedChannel.deleteExchange(queueName);
      rabbit._cachedChannel.deleteQueue(queueName);

      // give rabbit time enough to perform cleanup
      setTimeout(done, 500);
    });

    var start = new Date().getTime();

    var kDelayMS = 2500;

    var testData = {
      testProp: 'timed-example-data-' + queueName
    };

    rabbit.subscribe(queueName);
    rabbit.bindExchangeToQueue(queueName, queueName);
    rabbit.on(queueName, function(message) {
      message.ack();

      // here we'll assert that the data is the same, plus that the time of delivery is at least kDelayMS give or take kAcceptableTimerThreshold
      var delay = Math.abs(new Date().getTime() - start);
      expect(delay).to.be.above(kDelayMS - kAcceptableTimerThreshold);
      expect(JSON.stringify(testData)).to.equal(JSON.stringify(message.data));

      done();
    });

    rabbit.setTimer(queueName, 'unique_id_tester_1', testData, kDelayMS);
  });

  it('should not receive a message if #clearTimer is called', function(done) {
    this.timeout(10000);

    var queueName = uuid.v4() + '.clear_timer_test';

    after(function(done) {
      // cleanup
      rabbit._cachedChannel.deleteExchange(queueName);
      rabbit._cachedChannel.deleteQueue(queueName);

      // give rabbit time enough to perform cleanup
      setTimeout(done, 500);
    });

    var start = new Date().getTime();

    var kDelayMS = 1500;

    var testData = {
      testProp: 'timed-example-data-' + queueName
    };

    var receivedMessages = 0;

    // listen for messages on the queue - nothing should be received here if this works!
    rabbit.subscribe(queueName);
    rabbit.bindExchangeToQueue(queueName, queueName);
    rabbit.on(queueName, function(message) {
      message.ack();

      receivedMessages++;
    });

    // set the timer and schedule the clear
    rabbit.setTimer(queueName, 'unique_clearing_test_id', testData, kDelayMS);
    setTimeout(function() {
      rabbit.clearTimer(queueName, 'unique_clearing_test_id');
    }, kDelayMS - 1000);

    // also set a timeout to fire after the message should have already have been delivered to check it wasn't
    setTimeout(function() {
      expect(receivedMessages).to.equal(0);

      done();
    }, kDelayMS + 1000);
  });
});