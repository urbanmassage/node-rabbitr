import Rabbitr = require('../');
const rabbit = new Rabbitr({
  url: 'amqp://guest:guest@localhost'
});

// @ts-ignore
rabbit.subscribe(['example.timer.to-clear'], 'example.timer.to-clear', null, (message) => {
  console.log('This should never fire!!!!');

  message.ack();

  setTimeout(function() {
    process.exit(1);
  }, 100);
});

const DELAY_MS = 2000;

rabbit.setTimer('example.timer.to-clear', 'unique_id_tester', {
  thisIs: 'timed-example-data',
  delayed: true
}, DELAY_MS).then(() => {
  console.log('Sent delayed message');
});

setTimeout(() => {
  // clear the timer, the delayed message should never be delivered!
  rabbit.clearTimer('example.timer.to-clear', 'unique_id_tester').then(() => {
    console.log('Cleared timer');
  });
}, 1000);

setTimeout(() => {
  console.log('Timer did not fire, awesome!');
  process.exit(0);
}, DELAY_MS + 1000);
