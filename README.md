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
});
```

## Basic queue usage

```js
// in one module
rabbit.subscribe(['booking.create'], 'sms.send.booking.create', {}, (message) => {
	// send an sms
	message.ack();
});

// in another module
rabbit.subscribe(['booking.create'], 'email.send.booking.create', {}, (message) => {
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
rabbit.subscribe(['booking.create'], 'booking.not-confirmed.timer.set', {}, (message) => {
  // do something to calculate how long we want the timer to last
	var timeFromNow = 900000; // 15 mins

	rabbit.setTimer('booking.not-confirmed.timer.fire', message.data.id, {
    id: message.data.id,
	}, timeFromNow);

	message.ack();
});

// clear timer if something has happened that means the timer action isn't required
rabbit.subscribe(['booking.confirm'], 'booking.not-confirmed.timer.clear', {}, (message) => {
	rabbit.clearTimer('booking.not-confirmed.timer.fire', message.data.id);

	message.ack();
});

// handle the timer firing
rabbit.subscribe(['booking.not-confirmed.timer.fire'], 'booking.not-confirmed.timer.fire', {}, (message) => {
	// do something off the back of the timer firing
	// in this example, message.data.id is the booking id that wasn't confirmed in time
	message.ack();
});
```

## RPC (remote procedure call)
Use Rabbitr's RPC methods if you need to do something and get a response back, and you want to decouple the two processes via MQ

- Make sure you use the same major version of Rabbitr on both the worker and scheduler sides!

### Define the worker's method
Use `prefetch` in the options object to define concurrency (defaults to `1`).

```js
rabbit.rpcListener('rpc-test', { prefetch: 5 }, async (message) => {
	// do something with message.data

	await doSomethingAsyncThatMightThrow(message.data);

  return {
    rpc: 'is cool'
	};
});
```

### Calling the worker's RPC
Define the timeout in milliseconds in the options object for `rpcExec`

```js
rabbit.rpcExec('rpc-test', { some: 'data' }, { timeout: 5000 }).then((response) => {
	// do something with `response`
	// it will look like { rpc: 'is cool' }
});
```

## Debugging

To debug rabbitr, you can enable logging by setting the environment variable
`DEBUG` to "rabbitr".

You can also tell rabbitr to only listen on one or few queues using the
environment variable `RABBITR_DEBUG`. Just set it to a comma-separated list of
queues names. RPC queues have the prefix `rpc.`.

```bash
# To enable logging
DEBUG=rabbitr node .

# To only listen on rpc channels `user.create` and `user.update`
RABBITR_DEBUG=rpc.user.create,rpc.user.update node .
```
