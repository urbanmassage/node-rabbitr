import Rabbitr = require('../');

const rabbit = new Rabbitr({
  url: 'amqp://guest:guest@localhost',
  queuePrefix: 'yo'
});

rabbit.rpcListener('example.rpc', null, function(message, cb) {
  console.log('Got message', message);
  console.log('Message data is', message.data);

  message.ack();

  cb(null, {
    thisIs: 'the-response'
  })
});

rabbit.rpcExec('example.rpc', {
  thisIs: 'the-input'
}).then((response) => {
  console.log('Got RPC response', response.data);

  setTimeout(function() {
    process.exit(0);
  }, 100);
});
