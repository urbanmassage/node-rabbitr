var uuid = require('uuid');
var expect = require('chai').expect;
var Rabbitr = require('../lib/rabbitr');

describe('rabbitr#rpc', function() {
    it('should receive messages on rpcListener', function(done) {
        this.timeout(5000);

        var queueName = uuid.v4() + '.rpc_test';

        after(function(done) {
            // cleanup
            rabbit._cachedChannel.deleteExchange('rpc.'+queueName);
            rabbit._cachedChannel.deleteQueue('rpc.'+queueName);
            rabbit._cachedChannel.deleteExchange('rpc.'+queueName+'.return');

            // give rabbit time enough to perform cleanup
            setTimeout(done, 500);
        });

        var rabbit = new Rabbitr({
            url: 'amqp://guest:guest@localhost'
        });

        var testData = {
            testProp: 'rpc-example-data-' + queueName
        };
        var responseData = {
            testing: 'return-'+queueName
        };

        rabbit.rpcListener(queueName, function(message, cb) {
            // here we'll assert that the data is the same
            expect(JSON.stringify(testData)).to.equal(JSON.stringify(message.data));

            message.queue.shift();

            cb(null, responseData);
        });

        rabbit.rpcExec(queueName, testData, function(err, message) {
            // here we'll assert that the data is the same - hitting this point basically means the test has passed anyway :)
            expect(JSON.stringify(responseData)).to.equal(JSON.stringify(message.data));

            done();
        });
    });
});