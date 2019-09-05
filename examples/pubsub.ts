import Rabbitr = require('../');
const rabbit = new Rabbitr({
  url: 'amqp://guest:guest@localhost'
});

rabbit.subscribe(['example.exchange'], 'example.queue', null, message => {
  console.log('Got message', message);
  console.log('Message data is', message.data);

  message.ack();

  setTimeout(function() {
    process.exit(0);
  }, 100);
});

rabbit.send('example.exchange', {
  thisIs: 'example-data',
})
