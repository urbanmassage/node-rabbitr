import Rabbitr = require('..');
import { expect } from 'chai';
import { v4 } from 'node-uuid';
import {Interval} from '../backoff/interval'
import {Exponential} from '../backoff/exponential'
import {Immediate} from '../backoff/immediate'
import { AbstractBackoff } from '../backoff/abstractbackoff';

const logics: {name:string, logic:AbstractBackoff, subscriberLogic: AbstractBackoff}[] = [
  { name: 'interval', logic:new Interval([5,10,20]), subscriberLogic: new Interval([1, 5, 10])},
  { name: 'exponential', logic: new Exponential(2, 3), subscriberLogic: new Exponential(1, 3)},
  { name: 'immediate', logic: new Immediate(3), subscriberLogic: new Immediate(5)}
]

for(let logic of logics){
  describe(`rabbitr#${logic.name}-backoff`, function() {
    let rabbit: Rabbitr;
    let backoff = logic.logic

    before(() =>
      (
        rabbit = new Rabbitr({
          url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost/%2F',
          backoffLogic: backoff
        })
      )
    );

    const createdExchanges: string[] = [];
    const createdQueues: string[] = [];

    after(() =>
      Promise.all([
        // cleanup
        ...createdExchanges.map(exchangeName =>
          rabbit._cachedChannel.deleteExchange(exchangeName, {})
        ),
        ...createdQueues.map(queueName =>
          rabbit._cachedChannel.deleteQueue(queueName, {})
        ),
      ]).then(() => rabbit.destroy())
    );

    it('should wait the amount of times specified in the backoff config', function(done) {
      this.timeout(60000);

      const exchangeName = `${v4()}_${logic.name}_backoff_test`;
      const queueName = `${v4()}_${logic.name}_backoff_test`;

      const testData = {
        testProp: `${logic.name}-example-data-` + queueName
      };

      let receivedIncrementer = 0;
      let lastReceivedUnixMS = null;

      rabbit.subscribe([exchangeName], queueName, {}, (message) => {
        receivedIncrementer++;

        if(!backoff.shouldRetry(receivedIncrementer)) {
          message.ack();
          setTimeout(() => {
            done();
          }, 100);
        }

        const nowUnixMS = new Date().getTime();
        if(lastReceivedUnixMS !== null) {
          expect(nowUnixMS - lastReceivedUnixMS).to.be.gt(backoff.getWaitTime(receivedIncrementer-1));
        }
        lastReceivedUnixMS = nowUnixMS;

        message.reject();

      });
      createdQueues.push(queueName);
      createdExchanges.push(exchangeName);

      setTimeout(() => {rabbit.send(exchangeName, testData)}, 200);
    });

    it('should wait the amount of times specified in the backoff config when at subscriber level', function(done) {
      this.timeout(60000);

      const exchangeName = `${v4()}_${logic.name}_backoff_test`;
      const queueName = `${v4()}_${logic.name}_backoff_test`;

      const testData = {
        testProp: `${logic.name}-example-data-` + queueName
      };

      let backoff = logic.subscriberLogic

      let receivedIncrementer = 0;
      let lastReceivedUnixMS = null;

      rabbit.subscribe([exchangeName], queueName, {backoffLogic:backoff}, (message) => {
        receivedIncrementer++;

        if(!backoff.shouldRetry(receivedIncrementer)) {
          message.ack();
          setTimeout(() => {
            done();
          }, 100);
        }

        const nowUnixMS = new Date().getTime();
        if(lastReceivedUnixMS !== null) {
          expect(nowUnixMS - lastReceivedUnixMS).to.be.gt(backoff.getWaitTime(receivedIncrementer-1));
        }
        lastReceivedUnixMS = nowUnixMS;

        message.reject();

      });
      createdQueues.push(queueName);
      createdExchanges.push(exchangeName);

      setTimeout(() => {rabbit.send(exchangeName, testData)}, 200);
    });
  });
}
