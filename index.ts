import * as amqplib from 'amqplib';
import { cyan, red, yellow } from 'chalk';
import { v4 } from 'node-uuid';
import { fromCallback } from 'promise-cb';
import { initWhitelist, log, shouldSkipSubscribe } from './lib/debug';
import { parse, parseError, stringify, stringifyError } from './lib/serialization';
import { wait } from './lib/wait';


const DEFAULT_RPC_EXPIRY = 15000; // 15 seconds
const BACKOFF_EXPIRY = 2000; // we use a fixed backoff expiry for now of 2 seconds

function maybeFromCallback<T>(fn: ((done: Rabbitr.Callback<T>) => void) | (() => PromiseLike<T>)): Promise<T> {
  let callback: Rabbitr.Callback<T>;
  let promise = fromCallback<T>(_callback => (callback = _callback) && void 0);

  let val = (fn as Function)(callback);
  if (val && val.then) {
    return Promise.resolve<T>(val);
  }
  return promise;
}

class TimeoutError extends Error {
  topic: string;
  isRpc: boolean;
  name = 'TimeoutError';
  constructor(details: { isRpc: boolean, topic: string }) {
    super();
    this.isRpc = details.isRpc;
    this.topic = details.topic;
    this.message = `${details.isRpc ? 'RPC request ' : ''}timed out on topic ${this.topic}`;
    (Error as any).captureStackTrace(this, this.constructor)
  }
}

class Rabbitr {
  opts: Rabbitr.IOptions;

  /** @deprecated */
  protected ready = false;
  /** @deprecated */
  protected connected = false;

  protected connection: amqplib.Connection;

  protected log = log;

  private _openChannels: amqplib.Channel[];

  private _timerChannel: amqplib.Channel;
  private _backoffChannel: amqplib.Channel;
  private _publishChannel: amqplib.Channel;
  private _rpcReturnChannel: amqplib.Channel;
  _cachedChannel: amqplib.Channel;

  private connectionPromise: Promise<amqplib.Connection>;

  private isShuttingDown: boolean = false;
  private pendingMessagesCount: number = 0;
  private shutdown = () => {
    this.isShuttingDown = true;
    this.log(`${red('shutting down')}`);
    return this.postMessage();
  };
  private postMessage() {
    if (this.isShuttingDown) {
      if (this.pendingMessagesCount) {
        // wait
        this.log(`we have ${yellow(this.pendingMessagesCount + '')} pending messsges`);
      }
    }
  }

  /**
   * An array of channel names used for debug mode. If this value is set, calls to
   *   #subscribe on channels not in this list will be ignored.
   *
   * This option is set from the environment variable `RABBITR_DEBUG`.
   */
  private debugChannelsWhitelist: string[] | void;

  constructor(opts: Rabbitr.IOptions) {
    this.debugChannelsWhitelist = initWhitelist();

    this.opts = Object.assign({
      url: '',
      defaultRPCExpiry: DEFAULT_RPC_EXPIRY,
    }, opts);
    this.opts.connectionOpts = Object.assign({
      heartbeat: 1
    }, opts && opts.connectionOpts || {});

    // istanbul ignore next
    if (!this.opts.url) {
      throw new Error('Missing `url` in Rabbitr options');
    }

    if (this.opts.log) {
      this.log = this.opts.log;
    }

    this._openChannels = [];

    // begin to initiate the connection now
    this.log('#connect');
    this.log(`using connection url ${yellow(this.opts.url)}`);
    this.connectionPromise = this.initiateConnection();
    this.connectionPromise.catch((err) => {
      console.error('failed to connect to rabbit');
      console.error(err);
      process.exit(1);
    });
  }

  private async initiateConnection(): Promise<amqplib.Connection> {
    // start by opening an AMQP connection
    this.connection = await amqplib.connect(this.opts.url, this.opts.connectionOpts);

    // make sure to close the connection if the process terminates
    process.once('SIGINT', this.shutdown);
    process.once('SIGTERM', this.shutdown);
    this.connection.on('close', () => {
      process.removeListener('SIGINT', this.shutdown);
      process.removeListener('SIGTERM', this.shutdown);
      if (!this.isShuttingDown) {
        throw new Error('Disconnected from RabbitMQ');
      }
      this.log(`connection closed`);
    });

    // now setup all the channels necessary for standard operation
    const channels = await Promise.all([
      this.connection.createChannel(),
      this.connection.createChannel(),
    ]);
    this._timerChannel = channels[0];
    this._publishChannel = channels[0];
    this._backoffChannel = channels[0];
    this._cachedChannel = channels[0];
    this._rpcReturnChannel = channels[1];
    this._openChannels = this._openChannels.concat(channels);

    // mark the connection as open and perform any 'setup' method if one is set
    this.connected = true;

    // mark this instance as 'ready' and end the promise
    this.ready = true;
    return this.connection;
  }

  /** method to destroy anything for this instance of rabbitr */
  async destroy() {
    if(!this.connected) {
      this.log(`${red('unable to destroy this instance as it is not connected')}`);
      return;
    }

    // mark this instance as no longer valid
    this.log(`${red('destroying')}`);
    this.ready = false;
    this.connected = false;

    // close the connection
    await this.connection.close();
    this.log('connection closed');
    this.connectionPromise = null;
    this.connection = null;
  }

  // standard pub/sub stuff

  async send(topic: string, data: any, opts?: Rabbitr.ISendOptions): Promise<void>;
  async send<TInput>(topic: string, data: TInput, opts?: Rabbitr.ISendOptions): Promise<void>;

  async send<TInput>(topic: string, data: TInput, opts?: Rabbitr.ISendOptions): Promise<void> {
    await this.connectionPromise;
    this.log(yellow('send'), topic, data, opts);

    // first ensure the exchange exists
    await this._publishChannel.assertExchange(topic, 'topic', {});

    // then publish the message
    const isSuccess = this._publishChannel.publish(topic, '*', Buffer.from(stringify(data)), {
      contentType: 'application/json',
    });

    if(!isSuccess) {
      throw new Error(`Failed to publish to topic ${topic} with data ${data}`);
    }
  }

  async subscribe(exchangeNames: string[], queueName: string, opts: Rabbitr.ISubscribeOptions, executorFunc: (data: Rabbitr.IMessage<any>) => void): Promise<amqplib.Channel>;
  async subscribe<TMessage>(exchangeNames: string[], queueName: string, opts: Rabbitr.ISubscribeOptions, executorFunc: (data: Rabbitr.IMessage<TMessage>) => void): Promise<amqplib.Channel>;
  async subscribe<TMessage>(exchangeNames: string[], queueName: string, opts: Rabbitr.ISubscribeOptions, executorFunc: (data: Rabbitr.IMessage<TMessage>) => void): Promise<amqplib.Channel> {
    await this.connectionPromise;

    this.log(cyan('subscribe'), exchangeNames, queueName, opts);

    // here we bind all the exchanges into the queues
    await Promise.all(exchangeNames.map((exchangeName) => this._bindExchangeToQueue(exchangeName, queueName)));

    if (
      shouldSkipSubscribe(this.debugChannelsWhitelist, queueName)
    ) {
      // this queueName should be skipped as it's not in the 'debug whitelist'
      this.log(red('skipped'), cyan('subscribe'), queueName);
      return;
    }

    // first, open a unique connection for this subscription
    const channel = await this.connection.createChannel();
    this._openChannels.push(channel);

    // ensure the queue we want to listen on actually exists
    await channel.assertQueue(queueName, Object.assign({
      durable: true,
    }, opts));

    // set the concurrency on the channel
    channel.prefetch(opts && opts.prefetch || 1);

    // define the internal message processing handler
    const processMessage = async (msg: any) => {
      if (!msg) return;
      if (this.isShuttingDown) {
        this.log(`${red('rejected')} message on queueName ${yellow(queueName)} because we're shutting down`);
        channel.nack(msg);
        return;
      }

      let data = msg.content.toString();
      if (msg.properties.contentType === 'application/json') {
        data = parse(data);
      }

      this.log(`got a new message on ${cyan(queueName)}`, data);

      try {
        ++ this.pendingMessagesCount;

        // we create a new promise, and make the resolution an 'ack' and the rejection an 'nack'
        await new Promise<void>((ack: () => void, reject) => {
          const message: Rabbitr.IMessage<TMessage> = {
            send: this.send.bind(this),
            rpcExec: this.rpcExec.bind(this),
            topic: queueName,
            data,
            channel,
            ack,
            reject,
            properties: msg.properties,
          };

          executorFunc(message);
        });

        // if we hit here, we should ack
        this.log(`acking on ${cyan(queueName)}`, data);
        channel.ack(msg);
      }
      catch(err) {
        // if we hit here, we should nack
        if (!opts || !opts.skipBackoff) {
          // super simple backoff achieved by just delaying performing a #nack
          await wait(BACKOFF_EXPIRY);
        }
        this.log(`rejecting on ${cyan(queueName)}`, data);
        channel.nack(msg);
      }
      finally {
        -- this.pendingMessagesCount;
        this.postMessage();
      }
    };

    // start consuming, and return the channel we opened for this subscription
    await channel.consume(queueName, processMessage, {});
    return channel;
  }

  private async _bindExchangeToQueue(exchange: string, queue: string): Promise<void> {
    await this.connectionPromise;
    this.log(cyan('bindExchangeToQueue'), exchange, queue);

    const channel = await this.connection.createChannel();

    try {
      // make sure the queue and exchange exist
      await channel.assertQueue(queue, null);
      await channel.assertExchange(exchange, 'topic', null);

      // finally bind the queue + exchange together
      await channel.bindQueue(queue, exchange, '*', {});
    }
    catch(err) {
      // simply rethrow, try catch is just for finally
      throw err;
    }
    finally {
      // make sure to close the channel we opened
      await channel.close();
    }
  }

  // timed queue stuff
  private _timerQueueName(topic: string, uniqueID: string): string {
    return `dlq.${topic}.${uniqueID}`;
  }

  async setTimer<TData>(topic: string, uniqueID: string, data: TData, ttl: number): Promise<void> {
    await this.connectionPromise;
    this.log(yellow('setTimer'), topic, uniqueID, data);

    // format the queue name
    const timerQueue = this._timerQueueName(topic, uniqueID);

    // create the timer queue if it doesn't already exist
    await this._timerChannel.assertQueue(timerQueue, {
      durable: true,
      deadLetterExchange: topic,
      arguments: {
        'x-dead-letter-routing-key': '*',
      },
      expires: (ttl + 1000),
    });

    // now send the message direct into the timer
    this._timerChannel.sendToQueue(timerQueue, Buffer.from(stringify(data)), {
      contentType: 'application/json',
      expiration: `${ttl}`,
    });
  }

  async clearTimer(topic: string, uniqueID: string): Promise<void> {
    await this.connectionPromise;
    const timerQueue = this._timerQueueName(topic, uniqueID);
    this.log(yellow('clearTimer'), timerQueue);

    await this._timerChannel.deleteQueue(timerQueue, {});
  }

  // rpc helper methods
  private _rpcQueueName(topic: string): string {
    return `rpc.${topic}`;
  }
  private async _createTempQueue(queueName: string, channel: amqplib.Channel) {
    this.log(`creating temp queue ${cyan(queueName)}`);
    await channel.assertQueue(queueName, {
      exclusive: true,
      expires: (this.opts.defaultRPCExpiry * 1 + 1000),
      durable: false,
    });
  }

  async rpcExec(topic: string, data: any, opts?: Rabbitr.IRpcExecOptions): Promise<any>;
  async rpcExec<TInput, TOutput>(topic: string, data: TInput, opts?: Rabbitr.IRpcExecOptions): Promise<TOutput>;

  async rpcExec<TInput, TOutput>(topic: string, data: TInput, opts?: Rabbitr.IRpcExecOptions): Promise<TOutput> {
    await this.connectionPromise;

    // this will send the data down the topic and then open up a unique return queue
    const rpcQueue = this._rpcQueueName(topic);
    const unique = v4() + '_' + ((Math.round(new Date().getTime() / 1000) + '').substr(5));
    const returnQueueName = `${rpcQueue}.return.${unique}`;
    const now = new Date().getTime();
    const channel = this._rpcReturnChannel;
    const replyQueue = returnQueueName;

    // used to determine whether we should ignore timeouts
    let isCompleted = false;

    let replyConsumerTag: string = null;

    try {
      // bind the response queue
      await this._createTempQueue(replyQueue, channel);
      this.log(`using rpc return queue ${cyan(returnQueueName)}`);

      const timeoutMS = opts && opts.timeout || this.opts.defaultRPCExpiry || DEFAULT_RPC_EXPIRY;

      // define a promise that will start now, and collect the result that comes back on the response queue
      const resultPromise = new Promise((completed: (responseData: TOutput) => void, failed) => {
        // define a method that the #consume method will call
        const gotReply = (msg) => {
          if (!msg) return;
          this.log('got rpc reply', msg.content);

          isCompleted = true;

          // we got a reply, try and parse it
          try {
            let data: any = msg.content.toString();
            if (msg.properties.contentType === 'application/json') {
              data = parse(data);
            }

            let error = data.error;
            const response: TOutput = data.response;

            if (error) {
              if (data.isError) {
                throw parseError(error);
              } else {
                throw parse(error);
              }
            }

            completed(response);
          }
          catch(err) {
            // send the failure to the rejection of the promise
            failed(err);
          }
        };

        channel.consume(replyQueue, gotReply, {noAck: true}).then((response) => {
          replyConsumerTag = response.consumerTag;
        }).catch((err) => {
          failed(err);
        });
      });

      // send the request now
      const request = {
        d: data,
        returnQueue: replyQueue,
        expiration: now + timeoutMS,
      };
      this.log('sending rpc request');
      this._publishChannel.sendToQueue(rpcQueue, Buffer.from(stringify(request)), {
        contentType: 'application/json',
        expiration: `${timeoutMS}`,
      });

      // race the result against a timeout promise
      const result = await Promise.race<TOutput>([
        resultPromise,
        wait(timeoutMS).then(() => {
          if (isCompleted) {
            return null;
          }

          this.log(`request timeout firing for ${rpcQueue} to ${returnQueueName}`);
          throw new TimeoutError({isRpc: true, topic});
        })
      ]);

      return result;
    }
    catch(err) {
      // rethrow, this try catch only exists for the finally
      throw err;
    }
    finally {
      // clean up our temp queue now we're done
      channel.deleteQueue(replyQueue, {}).catch((err) => {
        this.log(`failed to remove temp queue ${replyQueue} due to error `, err);
      });

      if (replyConsumerTag) {
        channel.cancel(replyConsumerTag).catch((err) => {
          this.log(`failed to cancel replyConsumerTag ${replyConsumerTag} due to error `, err);
        });
      }
    }
  }

  async rpcListener(topic: string, opts: Rabbitr.IRpcListenerOptions<any, any>, executor: Rabbitr.IRpcListenerExecutor<any, any>): Promise<void>;
  async rpcListener<TInput, TOutput>(topic: string, opts: Rabbitr.IRpcListenerOptions<TInput, TOutput>, executor: Rabbitr.IRpcListenerExecutor<TInput, TOutput>): Promise<void>;

  async rpcListener<TInput, TOutput>(topic: string, opts: Rabbitr.IRpcListenerOptions<TInput, TOutput>, executor: Rabbitr.IRpcListenerExecutor<TInput, TOutput>): Promise<void> {
    await this.connectionPromise;

    const rpcQueueName = this._rpcQueueName(topic);
    this.log(`has rpcListener for ${topic}`);

    await this.subscribe(
      [],
      rpcQueueName,
      Object.assign({}, opts, {
        skipBackoff: true,
        durable: false,
      }),
      async (envelope: Rabbitr.IEnvelopedMessage<TInput>) => {
        // this method runs when we receive a new message
        try {
          const dataEnvelope = envelope.data;
          const now = new Date().getTime();

          if (now > dataEnvelope.expiration) {
            // we consider the message as 'expired' if the current clock time is after the point at which we think the client would have fired their expiry promise
            // NB - this means that clock drift between client + server can cause unwanted timeouts
            envelope.ack();
            return;
          }

          const message: Rabbitr.IMessage<TInput> = <Rabbitr.IEnvelopedMessage<TInput> & Rabbitr.IMessage<TInput>>envelope;
          message.data = dataEnvelope.d;

          let responseData: any;
          try {
            const response = await maybeFromCallback(executor.bind(null, message));
            responseData = { response };
            this.log(`${yellow('rpcListener')} responding to topic ${cyan(topic)} with`, response);
          }
          catch(err) {
            this.log(`${yellow('rpcListener')} on topic ${cyan(topic)} ${red('hit error')}`, err);

            const isError = err instanceof Error;
            const errJSON = isError ?
              stringifyError(err) :
              stringify(err);

            responseData = {
              error: errJSON,
              isError,
            };
          }

          // ack here - this will get ignored if the executor has acked or nacked already anyway
          message.ack();

          // doesn't need wrapping in this.formatName as the rpcExec function already formats the return queue name as required
          this._publishChannel.sendToQueue(dataEnvelope.returnQueue, Buffer.from(stringify(responseData)), {
            contentType: 'application/json',
          });
        }
        catch(err) {
          // something failed when processing the message, nack it
          envelope.reject();
        }
      }
    );
  }
};

declare module Rabbitr {
  /** you MUST provide a 'url' rather than separate 'host', 'password', 'vhost' now */
  export interface IOptions {
    url: string;
    log?: (...args: string[]) => void;

    connectionOpts?: {
      heartbeat?: boolean;
    };
    defaultRPCExpiry?: number;
  }

  export interface ErrorCallback {
    (err: Error): void;
  }

  export interface Callback<T> {
    (err: Error): void;
    (err: Error, data: T): void;
  }

  export interface IRpcExecOptions {
    timeout?: number;
  }
  export interface IRpcListenerOptions<TInput, TOutput> {
    prefetch?: number;
  }
  export type IRpcListenerExecutor<TInput, TOutput> =
    ((message: IMessage<TInput>) => PromiseLike<TOutput>) |
    ((message: IMessage<TInput>, respond: Callback<TOutput>) => void);

  export interface ISubscribeOptions {
    prefetch?: number;
    skipBackoff?: boolean;
    durable?: boolean;
  }
  export interface ISendOptions {
  }

  export interface IMessage<TData> {
    ack(): void;
    reject(error?: Error): void;

    topic: string;
    channel: amqplib.Channel;
    data: TData;
    properties?: any;

    send(topic: string, data: any, cb?: Rabbitr.ErrorCallback, opts?: Rabbitr.ISendOptions): Promise<void>;
    send<TInput>(topic: string, data: TInput, cb?: Rabbitr.ErrorCallback, opts?: Rabbitr.ISendOptions): Promise<void>;

    rpcExec(topic: string, data: any, cb?: Rabbitr.Callback<any>): Promise<any>;
    rpcExec(topic: string, data: any, opts: Rabbitr.IRpcExecOptions, cb?: Rabbitr.Callback<any>): Promise<any>;
    rpcExec<TInput, TOutput>(topic: string, data: TInput, cb?: Rabbitr.Callback<TOutput>): Promise<TOutput>;
    rpcExec<TInput, TOutput>(topic: string, data: TInput, opts: Rabbitr.IRpcExecOptions, cb?: Rabbitr.Callback<TOutput>): Promise<TOutput>;

    queue?: {
      shift: () => void;
    };
  }

  export interface IEnvelopedMessage<TData> extends IMessage<any> {
    data: {
      d: TData,
      expiration: number,
      returnQueue: string,
    };
  }
}

export = Rabbitr;
