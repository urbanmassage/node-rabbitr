# CHANGELOG

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
