import Rabbitr = require('../');
const rabbit = new Rabbitr({
  url: 'amqp://guest:guest@localhost'
});

rabbit.subscribe('example.timer');
rabbit.bindExchangeToQueue('example.timer', 'example.timer');
rabbit.on('example.timer', function(message, done) {
  console.log('Got delayed message', message);
  console.log('Delayed message data is', message.data);

  done();

  setTimeout(function() {
    process.exit(0);
  }, 100);
});

const DELAY_MS = 15000;

rabbit.setTimer('example.timer', 'unique_id_tester', {
  thisIs: 'timed-example-data',
  delayed: true
}, DELAY_MS, function(err) {
  console.log('Sent delayed message', err);
});
