# CHANGELOG

## next
- [BREAKING] `Rabbitr` is no longer a subclass of `EventEmitter`. So we don't emit
  `error` events anymore. Everything else should keep working as expected.
- [BREAKING] If you subscribe to a topic twice an error will be thrown.
- [BREAKING] `ack` and `reject` on `IMessage` were removed. Either return a promise or use callbacks in `Rabbitr#on` (now second argument).
- [BREAKING] middleware has been re-done from scratch. Check readme on how to use it.
- [BREAKING] removed support for callbacks and updated most function signatures. You can maintain backwards compatibility by using `Bluebird#asCallback`, which is what rabbitr used to do anyway.
- Add support for sending an receiving headers

## 8.4.0
- fixed a bug that caused the return value of `rpcExec` and other methods to always be `undefined` if called before the connection was established.
- introduced debug mode (via `RABBITR_DEBUG` env variable. check README.md)
- graceful shutdown: when SIGINT is received rabbitr will stop listening for incoming
messages but will continue processing pending messages if any and then disconnect from
rabbitmq.

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
