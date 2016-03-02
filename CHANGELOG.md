# CHANGELOG

## 8.0.6
- use `object-assign` instead of `merge`.

## 8.0.5
- output a typescript declaration file, reducing the number of typings dependencies.

## 8.0.0
 * All rpcListener queues will need re-creating during deployment in RabbitMQ
  if you ran an older version due to the move from durable to non-durable queues.
