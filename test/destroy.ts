import Rabbitr = require('../');
import async = require('async');
import {expect} from 'chai';

describe('rabbitr#destroy', function() {
  it('should be able to destroy an instance once initialized', function(done) {
    const rabbit = new Rabbitr({
      url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
    });
    rabbit.whenReady(() => {
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
        }, 200);
      });
    }

    /** number of times to run a connection cycle */
    let times = 5;

    this.timeout(1000 * times);

    // run a cycle before so we get accurate measures.
    runCycle(err => {
      if (err) return done(err);
      let {heapUsed} = process.memoryUsage();

      async.timesSeries<void>(times, (n, done) => runCycle(<any>done), function(err) {
        if (err) return done(err);

        expect(process.memoryUsage().heapUsed).to.be.closeTo(heapUsed, heapUsed * 0.1);
        done();
      });
    });
  });
});
