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

## Error handling for queues

Any time you have an unhandled exception, it will cause a redelivery - this typically causes the message to be sent to another consumer of the same queue, in order to be retried. You can simulate this by writing a simple `throw new Error('test')` statement into the async function you define as the executor for your queue.

This means you should typically handle, log, and swallow errors which will prevent the message ever being processed successfully, in order to avoid a "redelivery loop" (when a message keeps getting retried with no chance of succeeding). As an example, a temporary loss of a database connection would be sensible to force into a redelivery, however a validation error within the data of the message that requires fresh data to be submitted by a user may not want to be redelivered.

## Basic queue usage

```js
// in one module
rabbit.subscribe(['booking.create'], 'sms.send.booking.create', {}, async (message) => {
	// send an sms
	console.log('send sms for', message.data.id);
});

// in another module
rabbit.subscribe(['booking.create'], 'email.send.booking.create', {}, async (message) => {
	// send an email
	console.log('send email for', message.data.id);
});

// elsewhere
async function createBooking() => {
  await rabbit.send('booking.create', {id: 1});
}
```

## Timers
Rabbitr makes using dead letter exchanges dead easy

```js
// set timer
rabbit.subscribe(['booking.create'], 'booking.not-confirmed.timer.set', {}, async (message) => {
  // do something to calculate how long we want the timer to last
	const timeFromNow = 900000; // 15 mins

	await rabbit.setTimer('booking.not-confirmed.timer.fire', message.data.id, {
    id: message.data.id,
	}, timeFromNow);
});

// clear timer if something has happened that means the timer action isn't required
rabbit.subscribe(['booking.confirm'], 'booking.not-confirmed.timer.clear', {}, async (message) => {
	await rabbit.clearTimer('booking.not-confirmed.timer.fire', message.data.id);
});

// handle the timer firing
rabbit.subscribe(['booking.not-confirmed.timer.fire'], 'booking.not-confirmed.timer.fire', {}, async (message) => {
	// do something off the back of the timer firing
	// in this example, message.data.id is the booking id that wasn't confirmed in time
	console.log('firing for id', message.data.id);
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
