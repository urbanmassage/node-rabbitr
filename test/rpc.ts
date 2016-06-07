import Rabbitr = require('../');
import {expect} from 'chai';
import {v4} from 'node-uuid';

describe('rabbitr#rpc', function() {
  const rabbit = new Rabbitr({
    url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
  });

  it('should receive messages on rpcListener', function(done) {
    const queueName = v4() + '.rpc_test';

    after(function(done) {
      // cleanup
      rabbit._cachedChannel.deleteExchange('rpc.'+queueName);
      rabbit._cachedChannel.deleteQueue('rpc.'+queueName);
      rabbit._cachedChannel.deleteExchange('rpc.'+queueName+'.return');

      // give rabbit time enough to perform cleanup
      setTimeout(done, 500);
    });

    const testData = {
      testProp: 'rpc-example-data-' + queueName
    };
    const responseData = {
      testing: 'return-'+queueName
    };

    rabbit.rpcListener(queueName, function(message, cb) {
      // here we'll assert that the data is the same
      expect(message.data).to.deep.equal(testData);

      message.queue.shift();

      cb(null, responseData);
    });

    rabbit.rpcExec(queueName, testData, function(err, data) {
      // here we'll assert that the data is the same - hitting this point basically means the test has passed anyway :)
      expect(err).to.not.exist;
      expect(data).to.deep.equal(responseData);

      done();
    });
  });

  it('passes errors back', function(done) {
    const queueName = v4() + '.rpc_test';

    const error = new Error('Test');

    rabbit.rpcListener(queueName, function(message, cb) {
      message.queue.shift();
      cb(error);
    });

    rabbit.rpcExec(queueName, {}, function(err, message) {
      expect(err).to.be.an.instanceOf(Error);
      // bluebird injects some extra props (like __stackCleaned__) so this won't work.
      // expect(err).to.deep.equal(error);

      ['name', 'message'].forEach(function(key) {
        // because these are not checked in deep-equal
        expect(err).to.have.property(key).that.is.deep.equal(error[key]);
      });

      expect(err).to.have.property('stack').that.has.string(error.stack);

      done();
    });
  });

  it('passes custom errors', function(done) {
    const queueName = v4() + '.rpc_test';

    const error = {a: 'b', c: 'd', name: 'Error', message: 'test'};

    rabbit.rpcListener(queueName, function(message, cb) {
      message.queue.shift();

      cb(error);
    });

    rabbit.rpcExec(queueName, {}, function(err, message) {
      expect(err).to.deep.equal(error);

      expect(err).not.to.be.an.instanceOf(Error);

      done();
    });
  });

  it('passes Buffers', function(done) {
    const queueName = v4() + '.rpc_test';

    const data = 'Hello world!';

    rabbit.rpcListener(queueName, function(message, cb) {
      message.queue.shift();
      expect(message.data).to.be.an.instanceOf(Buffer);
      expect(message.data.toString()).to.equal(data);
      cb(null, new Buffer(data));
    });

    rabbit.rpcExec(queueName, new Buffer(data), function(err, message) {
      expect(err).to.not.exist;

      expect(message).to.be.an.instanceOf(Buffer);
      expect(message.toString()).to.equal(data);
      done();
    });
  });

  it('timeouts', function(done) {
    const queueName = v4() + '.rpc_test';

    rabbit.rpcListener(queueName, function(message, cb) {
      message.queue.shift();
      // No reply...
    });

    rabbit.rpcExec(queueName, {}, {timeout: 10}, (err: Error, message?) => {
      expect(err).to.be.an.instanceOf(Error);
      expect(err).to.have.property('name').that.equals('TimeoutError');
      done();
    });
  });
});
