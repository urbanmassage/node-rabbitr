import Rabbitr = require('../');
import async = require('async');
import {expect} from 'chai';
const uuid = require('uuid');

describe('rabbitr#destroy', function() {
  it('should be able to destroy an instance once initialized', function(done) {
    const exchangeName = uuid.v4() + '.test';
    const queueName = uuid.v4() + '.test';

    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });
    rabbit.whenReady(() => {
      rabbit.subscribe(queueName);
      rabbit.bindExchangeToQueue(exchangeName, queueName);
      rabbit.on(exchangeName, ({ack}) => ack());

      setTimeout(function() {
        rabbit.destroy((err) => {
          done(err);
        });
      }, 200);
    });
  });

  let ifGcIt = global.gc ? it : it.skip;

  ifGcIt('doesn\'t leak', function(done) {
    function runCycle(done: (err: Error) => void) {
      const rabbit = new Rabbitr({
        url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
      });
      rabbit.whenReady(() => {
        setTimeout(function() {
          rabbit.destroy(err => {
            global.gc();
            done(err);
          });
        }, 100);
      });
    }

    /** number of times to run a connection cycle */
    let times = 5;

    // run a cycle before so we get accurate measures.
    async.timesSeries<void>(2, (n, done) => runCycle(<any>done), function(err) {
      if (err) return done(err);
      const {heapUsed} = process.memoryUsage();

      async.timesSeries<void>(times, (n, done) => runCycle(<any>done), function(err) {
        if (err) return done(err);

        expect(process.memoryUsage().heapUsed).to.be.lessThan(heapUsed * 1.01);
        done();
      });
    });
  });
});
