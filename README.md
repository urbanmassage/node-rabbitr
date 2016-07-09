# Rabbitr
[![TravisCI](https://img.shields.io/travis/urbanmassage/node-rabbitr.svg)](https://travis-ci.org/urbanmassage/node-rabbitr)
[![npm](https://img.shields.io/npm/v/rabbitr.svg)](https://www.npmjs.com/package/rabbitr)
[![npm](https://img.shields.io/npm/dt/rabbitr.svg)](https://www.npmjs.com/package/rabbitr)
[![Codecov](https://img.shields.io/codecov/c/github/urbanmassage/node-rabbitr.svg)](https://codecov.io/github/urbanmassage/node-rabbitr)

RabbitMQ made easy for nodejs

## Init / setup

```js
var rabbit = new Rabbitr({
	host: 'localhost',
	queuePrefix: null // prefixed to every queue and exchange name
});
```

## Basic queue usage

```js
// in one module
rabbit.subscribe('sms.send.booking.create');
rabbit.bindExchangeToQueue('booking.create', 'sms.send.booking.create');
rabbit.on('sms.send.booking.create', function(message) {
	// send an sms
	message.ack();
});

// in another module
rabbit.subscribe('email.send.booking.create');
rabbit.bindExchangeToQueue('booking.create', 'email.send.booking.create');
rabbit.on('email.send.booking.create', function(message) {
	// send an email
	message.ack();
});

// elsewhere
rabbit.send('booking.create', {id: 1});
```

## Timers
Rabbitr makes using dead letter exchanges dead easy

```js
// set timer
rabbit.subscribe('booking.not-confirmed.timer.set');
rabbit.bindExchangeToQueue('booking.create', 'booking.not-confirmed.timer.set');
rabbit.on('booking.not-confirmed.timer.set', function(message) {
	// do something to calculate how long we want the timer to last
	var timeFromNow = 900000; // 15 mins

	rabbit.setTimer('booking.not-confirmed.timer.fire', message.data.id, {
	    id: message.data.id
	}, timeFromNow);

	message.ack();
});

// clear timer if something has happened that means the timer action isn't required
rabbit.subscribe('booking.not-confirmed.timer.clear');
rabbit.bindExchangeToQueue('booking.confirm', 'booking.not-confirmed.timer.clear');
rabbit.on('booking.not-confirmed.timer.clear', function(message) {
	rabbit.clearTimer('booking.not-confirmed.timer.fire', message.data.id);

	message.ack();
});

// handle the timer firing
rabbit.subscribe('booking.not-confirmed.timer.fire');
rabbit.bindExchangeToQueue('booking.not-confirmed.timer.fire', 'booking.not-confirmed.timer.fire');
rabbit.on('booking.not-confirmed.timer.fire', function(message) {
	// do something off the back of the timer firing
	// in this example, message.data.id is the booking id that wasn't confirmed in time
	message.ack();
});
```

## RPC (remote procedure call)
Use Rabbitr's RPC methods if you need to do something and get a response back, and you want to decouple the two processes via MQ

- Make sure you use the same version of Rabbitr on both the worker and scheduler sides!
- Note that we call message.queue.shift() rather than message.ack() to confirm processing for RPC methods - this is as Rabbitr's rpcListener method is set up so you can process in series, or immediately ask for another message to process in (kind of) parallel

### Define the worker's method (series)

```js
rabbit.rpcListener('intelli-travel.directions', function(message, cb) {
	// do something with message.data

	cb(null, {
	    rpc: 'is cool'
	});
});
```

### Define the worker's method (parallel, kind of)

```js
rabbit.rpcListener('intelli-travel.directions', function(message, cb) {
	message.queue.shift(); // immediately moves on to processing the next
	// do something with message.data

	cb(null, {
	    rpc: 'is cool'
	});

	message.queue.shift();
});
```

### Calling the worker's RPC

```js
rabbit.rpcExec('intelli-travel.directions', { some: 'data' }, function(err, message) {
	// do something with message.data
	// message.data will look like { rpc: 'is cool' }
});
```

## Debugging

To debug rabbitr, you can enable logging by setting the environment variable
`DEBUG` to "rabbitr".

You can also tell rabbitr to only listen on one (or few) channels using the
environment variable `RABBITR_DEBUG`. Just set it to a comma-separated list of
channel names. RPC channels have the prefix `rpc.`.

```bash
# To enable logging
DEBUG=rabbitr node .

# To only listen on rpc channels `user.create` and `user.update`
RABBITR_DEBUG=rpc.user.create,rpc.user.update node .
```
