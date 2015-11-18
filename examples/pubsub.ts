var Rabbitr = require('../');
var rabbit = new Rabbitr({
  url: 'amqp://guest:guest@localhost'
});

rabbit.subscribe('example.queue');
rabbit.bindExchangeToQueue('example.exchange', 'example.queue');
rabbit.on('example.queue', function(message) {
  console.log('Got message', message);
  console.log('Message data is', message.data);

  message.ack();

  setTimeout(function() {
    process.exit(0);
  }, 100);
});

rabbit.send('example.exchange', {
  thisIs: 'example-data',
}, function(err) {
  console.log('Sending message', err);
});
