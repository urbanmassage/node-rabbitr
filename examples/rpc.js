var Rabbitr = require('../lib/rabbitr');
var rabbit = new Rabbitr({
	url: 'amqp://guest:guest@localhost',
    queuePrefix: 'yo'
});

rabbit.rpcListener('example.rpc', function(message, cb) {
	console.log('Got message', message);
	console.log('Message data is', message.data);

	message.ack();

	cb(null, {
		thisIs: 'the-response'
	})
});

rabbit.rpcExec('example.rpc', {
	thisIs: 'the-input'
}, function(err, response) {
	console.log('Got RPC response', response.data);

    setTimeout(function() {
        process.exit(0);
    }, 100);
});