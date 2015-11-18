import Rabbitr = require('../');
var rabbit = new Rabbitr({
  url: 'amqp://guest:guest@localhost'
});

rabbit.subscribe('example.timer.to-clear');
rabbit.bindExchangeToQueue('example.timer.to-clear', 'example.timer.to-clear');
rabbit.on('example.timer.to-clear', (message) => {
  console.log('This should never fire!!!!');

  message.ack();

  setTimeout(function() {
    process.exit(1);
  }, 100);
});

var kDelayMS = 2000;

rabbit.setTimer('example.timer.to-clear', 'unique_id_tester', {
  thisIs: 'timed-example-data',
  delayed: true
}, kDelayMS, (err: Error) => {
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
}, kDelayMS + 1000);