import {expect, use} from 'chai';
import sinon = require('sinon');
import sinonChai = require('sinon-chai');
use(sinonChai);

import Bluebird = require('bluebird');
import Rabbitr = require('../');
import {v4} from 'node-uuid';

describe('rabbitr#middleware', function() {
  let rabbit: Rabbitr;
  beforeEach(() =>
    (
      rabbit = new Rabbitr({
        url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
      })
    ).whenReady()
  );

  const createdExchanges: string[] = [];
  const createdQueues: string[] = [];

  afterEach(() =>
    Bluebird.all([
      // cleanup
      ...createdExchanges.map(exchangeName =>
        Bluebird.fromCallback(cb =>
          rabbit._cachedChannel.deleteExchange(exchangeName, {}, cb)
        )
      ),
      ...createdQueues.map(queueName =>
        Bluebird.fromCallback(cb =>
          rabbit._cachedChannel.deleteQueue(queueName, {}, cb)
        )
      ),
      Bluebird.delay(50),
    ]).then(() => rabbit.destroy())
  );

  it('should receive messages on rpcListener', () => {
    const queueName = v4() + '.rpc_test';

    const testData = {
      testProp: 'rpc-example-data-' + queueName
    };
    const responseData = {
      testing: 'return-'+queueName
    };

    const middleware = sinon.spy((message, next) => {
      expect(message).to.be.an('object');
      expect(message.data).to.deep.equal(testData);

      expect(next).to.be.a('function');
      return next()
        .then(response => {
          expect(response).to.deep.equal(responseData);
          return response;
        });
    });

    rabbit.middleware(middleware)

    return rabbit.rpcListener(queueName, message => {
      // here we'll assert that the data is the same
      expect(message.data).to.deep.equal(testData);

      return Bluebird.resolve(responseData);
    })
      .then(() => createdQueues.push('rpc.' + queueName))
      .then(() =>
        rabbit.rpcExec(queueName, testData)
          .then(data => {
            expect(data).to.deep.equal(responseData);

            expect(middleware).to.be.calledOnce;
          })
      );
  });

  it('should be able to handle errors on rpcListener', () => {
    const queueName = v4() + '.rpc_test';

    const errorMessage = 'Test error message';
    const testData = {
      testProp: 'rpc-example-data-' + queueName
    };
    const responseData = {
      testing: 'return-'+queueName
    };

    const middleware = sinon.spy((message, next) => {
      expect(message).to.be.an('object');
      expect(message.data).to.deep.equal(testData);

      expect(next).to.be.a('function');
      return next()
        .then(() => {
          expect.fail();
        }, error => {
          if (error.message !== errorMessage) throw error;
          return responseData;
        });
    });

    rabbit.middleware(middleware)

    return rabbit.rpcListener(queueName, message => {
      // here we'll assert that the data is the same
      expect(message.data).to.deep.equal(testData);

      return Bluebird.reject(new Error(errorMessage));
    })
      .then(() => createdQueues.push('rpc.' + queueName))
      .then(() =>
        rabbit.rpcExec(queueName, testData)
          .then(data => {
            expect(data).to.deep.equal(responseData);

            expect(middleware).to.be.calledOnce;
          })
      );
  });
});
