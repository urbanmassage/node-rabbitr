import Bluebird = require('bluebird');
import Rabbitr = require('../');
import {expect} from 'chai';
import {v4} from 'node-uuid';

const ACCEPTABLE_TIMER_THRESHOLD = 10;

describe('rabbitr#setTimer', function() {
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
      Bluebird.delay(50),
    ]).then(() => rabbit.destroy())
  );

  it('should receive a message after a set number of milliseconds', function(done) {
    const DELAY = 50;

    const queueName = v4() + '.timer_test';

    const start = new Date().getTime();

    const testData = {
      testProp: 'timed-example-data-' + queueName
    };

    rabbit.subscribe(queueName)
      .then(() => createdQueues.push(queueName))
      .then(() =>
        rabbit.bindExchangeToQueue(queueName, queueName)
          .then(() =>
            createdExchanges.push(queueName)
          )
          .then(() =>
            rabbit.setTimer(queueName, 'unique_id_tester_1', testData, DELAY)
          )
      );

    rabbit.on(queueName, function(message) {
      Bluebird.try(() => {
        message.ack();

        // here we'll assert that the data is the same, plus that the time of delivery is at least DELAY give or take kAcceptableTimerThreshold
        const delay = Math.abs(new Date().getTime() - start);
        expect(delay).to.be.above(DELAY - ACCEPTABLE_TIMER_THRESHOLD);
        expect(JSON.stringify(testData)).to.equal(JSON.stringify(message.data));
      }).asCallback(done);
    });
  });

  it('should not receive a message if #clearTimer is called', () => {
    const DELAY = 50;

    const queueName = v4() + '.clear_timer_test';

    const testData = {
      testProp: 'timed-example-data-' + queueName
    };

    let receivedMessages = 0;

    rabbit.subscribe(queueName)
      .then(() => createdQueues.push(queueName))
      .then(() =>
        rabbit.bindExchangeToQueue(queueName, queueName)
          .then(() =>
            createdExchanges.push(queueName)
          )
      );

    // listen for messages on the queue - nothing should be received here if this works!
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
    return Bluebird.delay(DELAY)
      .then(() => {
        expect(receivedMessages).to.equal(0);
      });
  });
});
