import Rabbitr = require('../');
const rabbit = new Rabbitr({
  url: 'amqp://guest:guest@localhost'
});

rabbit.subscribe('example.timer', null, (message) => {
  console.log('Got delayed message', message);
  console.log('Delayed message data is', message.data);

  message.ack();

  setTimeout(function() {
    process.exit(0);
  }, 100);
});
rabbit.bindExchangeToQueue('example.timer', 'example.timer');

const DELAY_MS = 15000;

rabbit.setTimer('example.timer', 'unique_id_tester', {
  thisIs: 'timed-example-data',
  delayed: true
}, DELAY_MS).then((err) => {
  console.log('Sent delayed message');
});
