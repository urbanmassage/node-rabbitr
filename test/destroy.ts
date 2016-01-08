import Rabbitr = require('../');
import {expect} from 'chai';

describe('rabbitr#destroy', function() {
  const rabbit = new Rabbitr({
    url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
  });
  before((done) => rabbit.whenReady(done));

  it('should be able to destroy an instance once initted', function(done) {
    setTimeout(function() {
      rabbit.destroy((err) => {
        expect(err).to.be.undefined;
        done();
      });
    }, 200);
  });
});
