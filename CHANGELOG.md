# CHANGELOG

# 12.0.0
- Removes support for `queuePrefix` in the constructor options
- Updates amqplib to `0.7.1`
- Moves away from deprecated `new Buffer()` constructor format to `Buffer.from()` internally

## 11.1.9
- Build on node 10 + 12

## 11.1.8
- Handle a null / undefined `opts` parameter for the `subscribe` method without getting into an error state on rejection

## 11.0.0
- Removes support for node before version 6
- Major rewrite which changes a lot of interfaces
- Removed support for callbacks
- Made the options object required for a number of calls
- Removed `bindExchangeToQueue`, instead you should pass a list of exchanges to the `subscribe` method as the first argument
- Automatically adds a 2 second delay when you reject a message (unless `skipBackoff` passed in the `subscribe` options), adding a faux backoff mechanism

## 8.6.0
- graceful shutdown now triggered by SIGINT or SIGTERM

## 8.5.0
- Fixed a race condition that resulted in a fatal error `404, "NOT_FOUND - no queue 'x' in vhost '/'"` when the main thread on the client is blocked.

## 8.4.0
- fixed a bug that caused the return value of `rpcExec` and other methods to always be `undefined` if called before the connection was established.
- introduced debug mode (via `RABBITR_DEBUG` env variable. check README.md)
- graceful shutdown: when SIGINT is received rabbitr will stop listening for incoming
messages but will continue processing pending messages if any and then disconnect from rabbitmq.

## 8.3.0
- use node-uuid instead of shortid

## 8.2.3
- critical bugfix in `subscribe`/`rpcListener` and durable queues

## 8.2.1
- bugfix when calling any method before connection is established
- callback/promise in `rpcListener`

## 8.2.0
- promises support

## 8.1.0
- not publishing source `.ts` files to npm anymore
- using separate source maps instead of inline ones

## 8.0.8
- made `TimeoutError` more useful by adding the topic to the error message and fixing an issue with stack being missing.

## 8.0.6
- use `object-assign` instead of `merge`.

## 8.0.5
- output a typescript declaration file, reducing the number of typings dependencies.

## 8.0.0
 * All rpcListener queues will need re-creating during deployment in RabbitMQ
  if you ran an older version due to the move from durable to non-durable queues.
