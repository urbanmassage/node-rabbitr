import Rabbitr = require('../lib/rabbitr');
var rabbit = new Rabbitr({
  url: 'amqp://guest:guest@localhost'
});

rabbit.subscribe('example.timer');
rabbit.bindExchangeToQueue('example.timer', 'example.timer');
rabbit.on('example.timer', function(message) {
  console.log('Got delayed message', message);
  console.log('Delayed message data is', message.data);

  message.ack();

  setTimeout(function() {
    process.exit(0);
  }, 100);
});

var kDelayMS = 15000;

rabbit.setTimer('example.timer', 'unique_id_tester', {
  thisIs: 'timed-example-data',
  delayed: true
}, kDelayMS, function(err) {
  console.log('Sent delayed message', err);
});
