import Rabbitr = require('../');
const rabbit = new Rabbitr({
  url: 'amqp://guest:guest@localhost'
});

rabbit.subscribe('example.timer.to-clear');
rabbit.bindExchangeToQueue('example.timer.to-clear', 'example.timer.to-clear');
rabbit.on('example.timer.to-clear', (message, done) => {
  console.log('This should never fire!!!!');

  done();

  setTimeout(function() {
    process.exit(1);
  }, 100);
});

const DELAY_MS = 2000;

rabbit.setTimer('example.timer.to-clear', 'unique_id_tester', {
  thisIs: 'timed-example-data',
  delayed: true
}, DELAY_MS, (err: Error) => {
  console.log('Sent delayed message', err);
});

setTimeout(() => {
  // clear the timer, the delayed message should never be delivered!
  rabbit.clearTimer('example.timer.to-clear', 'unique_id_tester', function(err) {
    console.log('Cleared timer', err);
  });
}, 1000);

setTimeout(() => {
  console.log('Timer did not fire, awesome!');
  process.exit(0);
}, DELAY_MS + 1000);
