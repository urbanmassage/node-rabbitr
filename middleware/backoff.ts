import {IMessage, MiddlewareCallback} from '../index';
import Bluebird = require('bluebird');
import objectAssign = require('object-assign');

export default function backoffMiddleware(message: IMessage<any>, next: MiddlewareCallback) {
  if (message.isRPC) return next();

  return Bluebird
    .try(next)
    .catch(rejection => {
      let retryNumber = parseFloat(message.headers && message.headers['x-retry-number']) || 0;
      ++retryNumber;

      console.error(`[rejection] #${retryNumber} on ${message.topic}`, rejection && rejection.stack || rejection);

      // send back to bottom of queue
      return Bluebird
        .delay(Math.pow(5, retryNumber))
        .then(
          () =>
            message.send(message.topic, message.data, {
              headers: objectAssign({}, message.headers, {
                'x-retry-number': retryNumber,
              }),
            })
        );
    });
}
