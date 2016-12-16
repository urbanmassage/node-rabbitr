import {cyan, red, yellow} from 'chalk';

import amqplib = require('amqplib/callback_api');
import objectAssign = require('object-assign');
import {v4} from 'node-uuid';
import Bluebird = require('bluebird');

import {initWhitelist, shouldSkipSubscribe, log} from './lib/debug';
import {stringify, stringifyError, parse, parseError} from './lib/serialization';

const DEFAULT_RPC_EXPIRY = 15000; // 15 seconds

function bluebirdUnwrapRejection<T>(rejection: T): T;
function bluebirdUnwrapRejection(rejection: any): any {
  if (rejection && rejection.isOperational && rejection.cause) {
    throw rejection.cause;
  }
  throw rejection;
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

interface RPCRequestEnvelope<TData> {
  d: TData;
  expiration: number;
  returnQueue: string;
}

let HAS_WARNED_ABOUT_V8_BREAKING_CHANGE = false;

class Rabbitr {
  private eventListeners: {
    [eventName: string]: Rabbitr.IEventListener<any>;
  } = {};

  on<Data>(eventName: string, listener: Rabbitr.IEventListener<Data>): void;
  on(eventName: string, listener: Rabbitr.IEventListener<any>): void;

  on(eventName: string, listener: Rabbitr.IEventListener<any>): void {
    if (this.eventListeners[eventName]) {
      throw new Error(`Adding multiple listeners to the same event is not supported.`);
    }

    if (typeof listener !== 'function') {
      throw new Error(`Invalid argument passed to Rabbitr#on: ${typeof listener}. Expected a function.`);
    }

    this.eventListeners[eventName] = listener;
  }

  off(eventName: string) {
    if (!this.eventListeners[eventName]) {
      throw new Error(`Attempted to remove a non-existent event listener: ${eventName}`);
    }
    this.eventListeners[eventName] = null;
  }

  private trigger(eventName: string, message: Rabbitr.IMessage<any>) {
    if (!this.eventListeners[eventName]) {
      throw new Error(`Triggering an event without a listener: ${eventName}`);
    }
    return this.eventListeners[eventName](message);
  }

  private removeAllListeners(): void {
    this.eventListeners = {};
  }

  opts: Rabbitr.IOptions;

  /** @deprecated */
  protected ready = false;
  /** @deprecated */
  protected connected = false;

  protected connection: amqplib.Connection;

  protected log = log;

  /**
   * An array of channel names used for debug mode. If this value is set, calls to
   *   #subscribe on channels not in this list will be ignored.
   *
   * This option is set from the environment variable `RABBITR_DEBUG`.
   */
  private debugChannelsWhitelist: string[] | void;

  constructor(opts: Rabbitr.IOptions) {
    if (!HAS_WARNED_ABOUT_V8_BREAKING_CHANGE) {
      console.warn('Rabbitr has a major breaking change in version 8 - rpcListener queues are no longer durable. You will need to remove all rpcListener queues from RabbitMQ during deployment.')
      HAS_WARNED_ABOUT_V8_BREAKING_CHANGE = true;
    }

    this.debugChannelsWhitelist = initWhitelist();

    this.opts = objectAssign(<Rabbitr.IOptions>{
      url: '',
      queuePrefix: '',
      ackWarningTimeout: 5000,
      autoAckOnTimeout: null,
      defaultRPCExpiry: DEFAULT_RPC_EXPIRY,
    }, opts);
    this.opts.connectionOpts = objectAssign({
      heartbeat: 1,
    }, opts && opts.connectionOpts);

    // istanbul ignore next
    if (!this.opts.url) {
      throw new Error('Missing `url` in Rabbitr options');
    }

    if (this.opts.log) {
      this.log = this.opts.log;
    }

    this._openChannels = [];

    this._connect();
  }

  private _openChannels: amqplib.Channel[];

  private _timerChannel: amqplib.Channel;
  private _publishChannel: amqplib.Channel;
  private _rpcReturnChannel: amqplib.Channel;
  _cachedChannel: amqplib.Channel;

  private connectionPromise: Bluebird<amqplib.Connection>;

  private isShuttingDown: boolean = false;
  private pendingMessagesCount: number = 0;
  private shutdown = () => {
    this.isShuttingDown = true;
    this.log(`${red('shutting down')}`);
    return this.postMessage();
  };

  private postMessage(): Bluebird<void> | void {
    if (this.isShuttingDown) {
      if (this.pendingMessagesCount) {
        // wait
        this.log(`we have ${yellow(`${this.pendingMessagesCount}`)} pending messsges`);
      } else {
        return this.destroy();
      }
    }
  }

  private _connect() {
    this.log('#connect');

    this.log(`using connection url ${yellow(this.opts.url)}`);

    this.connectionPromise = Bluebird.fromCallback<amqplib.Connection>(callback =>
      amqplib.connect(this.opts.url, this.opts.connectionOpts, callback)
    ).then(conn => {
      // make sure to close the connection if the process terminates
      process.once('SIGINT', this.shutdown);

      conn.on('close', () => {
        process.removeListener('SIGINT', this.shutdown);
        if (!this.isShuttingDown) {
          throw new Error('Disconnected from RabbitMQ');
        }
        this.log(`connection closed`);
      });

      return Bluebird.fromCallback<amqplib.Channel>(callback =>
        conn.createChannel(callback)
      ).then(channel => {
        this._timerChannel = channel;
        this._publishChannel = channel;
        this._cachedChannel = channel;

        this._openChannels.push(channel);

        return Bluebird.fromCallback<amqplib.Channel>(callback =>
          conn.createChannel(callback)
        ).then(channel => {
          this._rpcReturnChannel = channel;

          this._openChannels.push(channel);

          // cache the connection and do all the setup work
          this.connection = conn;
          this.connected = true;

          this.log('ready');
          return Bluebird.resolve(this.opts.setup ? this.opts.setup() : null)
            .then(() => {
              this.ready = true;
              return conn;
            });
        });
      });
    }).catch(error => {
      // istanbul ignore next
      process.nextTick(() => { throw error; });
    });
  }

  // istanbul ignore next
  public whenReady(): Bluebird<void> {
    return this.connectionPromise.then<void>(() => void 0);
  }

  private _formatName(name: string): string {
    // istanbul ignore next
    if (this.opts.queuePrefix) {
      return `${this.opts.queuePrefix}.${name}`;
    }

    return name;
  }

  private destroyPromise: Bluebird<void>;
  /** method to destroy anything for this instance of rabbitr */
  destroy(): Bluebird<void> {
    if (!this.destroyPromise) {
      this.log(`${red('destroying')}`);
      this.destroyPromise = Bluebird.each(this._openChannels, channel =>
        Bluebird.fromCallback(channel.close.bind(channel))
          .then(
            () => this.log('channel closed'),
            err => {
              // istanbul ignore next
              this.log('Error while closing connection', err);
              throw err;
            }
          )
      ).then(() => {
        return Bluebird.fromCallback(callback =>
          this.connection.close(callback)
        ).then(
          () => {
            this.log('connection closed');
            this.removeAllListeners();
            this.connectionPromise = null;
          },
          err => {
            // istanbul ignore next
            this.log('Error while closing connection', err);
            throw err;
          }
        );
      });
    }
    return this.destroyPromise;
  }

  // standard pub/sub stuff

  send(topic: string, data: any, opts?: Rabbitr.ISendOptions): Bluebird<void>;
  send<TInput>(topic: string, data: TInput, opts?: Rabbitr.ISendOptions): Bluebird<void>;

  send<TInput>(topic: string, data: TInput, opts?: Rabbitr.ISendOptions): Bluebird<void> {
    // istanbul ignore next
    if (!this.connectionPromise.isFulfilled()) {
      // delay until ready
      return this.whenReady().then(() =>
        this.send(topic, data, opts)
      );
    }

    this.log(yellow('send'), topic, data, opts);

    return Bluebird.fromCallback(callback =>
      this._publishChannel.assertExchange(this._formatName(topic), 'topic', {}, callback)
    ).then(() => {
      this._publishChannel.publish(
        this._formatName(topic),
        '*',
        new Buffer(stringify(data)),
        {
          contentType: 'application/json',
          headers: opts && opts.headers,
        }
      );
    });
  }

  subscribe(topic: string, opts?: Rabbitr.ISubscribeOptions): Bluebird<void>;
  subscribe<TMessage>(topic: string, opts?: Rabbitr.ISubscribeOptions): Bluebird<void>;

  subscribe<TMessage>(topic: string, opts?: Rabbitr.ISubscribeOptions): Bluebird<void> {
    // istanbul ignore next
    if (!this.connectionPromise.isFulfilled()) {
      // delay until ready
      return this.whenReady().then(() =>
        this.subscribe(topic, opts)
      );
    }

    const options: Rabbitr.ISubscribeOptions = opts;

    this.log(cyan('subscribe'), topic, options);

    if (
      shouldSkipSubscribe(this.debugChannelsWhitelist, topic)
    ) {
      this.log(red('skipped'), cyan('subscribe'), topic);
      return Bluebird.resolve();
    }

    return Bluebird.fromCallback<amqplib.Channel>(callback =>
      this.connection.createChannel(callback)
    ).then(channel => {
      this._openChannels.push(channel);

      return Bluebird.fromCallback(callback =>
        channel.assertQueue(this._formatName(topic), objectAssign({
          durable: true,
        }, options), callback)
      ).then(ok => {
        channel.prefetch(options ? options.prefetch || 1 : 1);

        const processMessage = (msg: any) => {
          if (!msg) return;
          if (this.isShuttingDown) {
            this.log(`${red('rejected')} message on topic ${yellow(topic)} because we're shutting down`);
            channel.nack(msg);
            return;
          }

          var data = msg.content.toString();
          if (msg.properties.contentType === 'application/json') {
            data = parse(data);
          }

          this.log(`got a new message on ${cyan(topic)}`, data);

          const messageAcknowledgement = Bluebird.try(() => {
            const message: Rabbitr.IMessage<TMessage> = {
              send: this.send.bind(this),
              rpcExec: this.rpcExec.bind(this),

              topic,
              data,
              channel,
              isRPC: false,
              headers: msg.properties.headers,
            };

            if (options && options.skipMiddleware) {
              return this.trigger(topic, message);
            }

            return this.useMiddleware(message, () =>
              this.trigger(topic, message)
            );
          }).then(
            // acknowledged
            () => {
              this.log(`acknowledging message ${cyan(topic)}`, data);
              channel.ack(msg);
            },
            // rejected
            error => {
              this.log(`rejecting message ${cyan(topic)}`, data, error);
              console.error(error && error.stack || error);
              channel.nack(msg);
            }
          );

          ++ this.pendingMessagesCount;

          // Add a timeout
          return Bluebird.race([
            messageAcknowledgement,
            Bluebird
              .delay(this.opts.ackWarningTimeout)
              .then(() => {
                throw new TimeoutError({isRpc: false, topic});
              }),
          ]).catch(TimeoutError, error => {
            if (this.opts.autoAckOnTimeout === 'acknowledge') {
              channel.ack(msg);
            } else if (this.opts.autoAckOnTimeout === 'reject') {
              channel.nack(msg);
            }
            return null;
          }).then(() => {
            -- this.pendingMessagesCount;
            this.postMessage();
          });
        };

        return Bluebird.fromCallback(callback =>
          channel.consume(this._formatName(topic), processMessage, {}, callback)
        );
      });
    });
  }

  bindExchangeToQueue(exchange: string, queue: string): Bluebird<void> {
    // istanbul ignore next
    if (!this.connectionPromise.isFulfilled()) {
      // delay until ready
      return this.whenReady().then(() =>
        this.bindExchangeToQueue(exchange, queue)
      );
    }

    this.log(cyan('bindExchangeToQueue'), exchange, queue);

    return Bluebird.fromCallback<amqplib.Channel>(callback =>
      this.connection.createChannel(callback)
    ).then(channel => {
      channel.assertQueue(this._formatName(queue));
      channel.assertExchange(this._formatName(exchange), 'topic');

      return Bluebird.fromCallback(callback =>
        channel.bindQueue(this._formatName(queue), this._formatName(exchange), '*', {}, callback)
      ).then(ok => {
        return Bluebird.fromCallback(callback => channel.close(callback));
      });
    });
  };

  // timed queue stuff
  private _timerQueueName(topic: string, uniqueID: string): string {
    return `dlq.${topic}.${uniqueID}`;
  }

  setTimer<TData>(topic: string, uniqueID: string, data: TData, ttl: number, opts?: Rabbitr.ISetTimerOptions): Bluebird<void> {
    // istanbul ignore next
    if (!this.connectionPromise.isFulfilled()) {
      // delay until ready
      return this.whenReady().then(() =>
        this.setTimer(topic, uniqueID, data, ttl)
      );
    }

    var timerQueue = this._timerQueueName(topic, uniqueID);

    this.log(yellow('setTimer'), topic, uniqueID, data);

    return Bluebird.fromCallback(callback =>
      this._timerChannel.assertQueue(this._formatName(timerQueue), {
        durable: true,
        deadLetterExchange: this._formatName(topic),
        arguments: {
          'x-dead-letter-routing-key': '*',
        },
        expires: (ttl + 1000)
      }, callback)
    ).then(() => {
      this._timerChannel.sendToQueue(this._formatName(timerQueue), new Buffer(stringify(data)), {
        contentType: 'application/json',
        expiration: `${ttl}`,
        headers: opts && opts.headers,
      });
    });
  }

  clearTimer(topic: string, uniqueID: string): Bluebird<void> {
    // istanbul ignore next
    if (!this.connectionPromise.isFulfilled()) {
      // delay until ready
      return this.whenReady().then(() =>
        this.clearTimer(topic, uniqueID)
      );
    }

    var timerQueue = this._timerQueueName(topic, uniqueID);

    this.log(yellow('clearTimer'), timerQueue);

    return Bluebird.fromCallback(callback =>
      this._timerChannel.deleteQueue(timerQueue, {}, callback)
    );
  }

  // rpc stuff
  private _rpcQueueName(topic: string): string {
    return `rpc.${topic}`;
  }

  private _getTempQueue(queueName: string, channel: amqplib.Channel) {
    this.log(`creating temp queue ${cyan(queueName)}`)
    return Bluebird.fromCallback<amqplib.Replies.AssertQueue>(callback =>
      channel.assertQueue(queueName, {
        exclusive: true,
        expires: (this.opts.defaultRPCExpiry * 1 + 1000),
        durable: false,
      }, callback)
    ).disposer(() => {
      this.log(`deleting temp queue ${cyan(queueName)}`);
      return Bluebird.fromCallback<any>(callback =>
        // delete the return queue and close exc channel
        channel.deleteQueue(queueName, {}, callback)
      ).catch(error => {
        // istanbul ignore next
        console.log(`rabbitr temp queue '${cyan(queueName)}' cleanup exception`, error && error.stack || error);
        throw error;
      }).then(() => {
        this.log(`deleted temp queue ${cyan(queueName)}`);
      });
    });
  }

  rpcExec(topic: string, data: any, opts?: Rabbitr.IRpcExecOptions): Bluebird<any>;
  rpcExec<TInput, TOutput>(topic: string, data: TInput, opts?: Rabbitr.IRpcExecOptions): Bluebird<TOutput>;

  rpcExec<TInput, TOutput>(topic: string, data: TInput, opts?: Rabbitr.IRpcExecOptions): Bluebird<TOutput> {
    // istanbul ignore next
    if (!this.connectionPromise.isFulfilled()) {
      // delay until ready
      return this.whenReady().then(() =>
        this.rpcExec<TInput, TOutput>(topic, data, opts)
      );
    }

    // this will send the data down the topic and then open up a unique return queue
    const rpcQueue = this._rpcQueueName(topic);

    const unique = `${v4()}_${((`${Math.round(new Date().getTime() / 1000)}`).substr(5))}`;
    const returnQueueName = `${rpcQueue}.return.${unique}`;

    const now = new Date().getTime();

    // bind the response queue

    const channel = this._rpcReturnChannel;

    const queueDisposer = this._getTempQueue(this._formatName(returnQueueName), channel);

    return Bluebird.using(queueDisposer, () => {
      this.log(`using rpc return queue ${cyan(returnQueueName)}`);

      const timeoutMS = (opts && opts.timeout || this.opts.defaultRPCExpiry || DEFAULT_RPC_EXPIRY) * 1;

      const replyQueue = this._formatName(returnQueueName);

      let replyCallback: Function;
      const replyPromise = Bluebird
        .fromCallback<amqplib.Message>(callback => { replyCallback = callback; });
      let gotReply = msg => {
        if (!msg) return;
        this.log(`got rpc reply on ${cyan(replyQueue)}`);

        replyCallback(null, msg);
      };

      return Bluebird.fromCallback(callback =>
        channel.consume(replyQueue, gotReply, {noAck: true}, callback)
      ).then<TOutput>(() => {
        // send the request now
        const request: RPCRequestEnvelope<TInput> = {
          d: data,
          returnQueue: this._formatName(returnQueueName),
          expiration: now + timeoutMS,
        };

        this.log('sending rpc request');
        this._publishChannel.sendToQueue(
          this._formatName(rpcQueue),
          new Buffer(stringify(request)),
          {
            contentType: 'application/json',
            expiration: `${timeoutMS}`,
            headers: opts && opts.headers,
          }
        );

        return Bluebird.race<amqplib.Message>([
          // set a timeout
          Bluebird.delay(timeoutMS).then<any>(() => {
            throw new TimeoutError({isRpc: true, topic});
          }),
          replyPromise,
        ]).then<TOutput>(
          msg => {
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

            // FIXME - find a way to return msg.properties.headers as well

            return response;
          },
          // TODO - investigate why bluebird wraps the error here
          //   with an object
          bluebirdUnwrapRejection
        ).catch(TimeoutError, error => {
          this.log(`request timeout firing for ${rpcQueue} to ${returnQueueName}`);
          throw error;
        });
      });
    });
  }

  rpcListener(topic: string, opts: Rabbitr.IRpcListenerOptions<any, any>, executor: Rabbitr.IRpcListenerExecutor<any, any>): Bluebird<void>;
  rpcListener<TInput, TOutput>(topic: string, opts: Rabbitr.IRpcListenerOptions<TInput, TOutput>, executor: Rabbitr.IRpcListenerExecutor<TInput, TOutput>): Bluebird<void>;

  rpcListener<TInput, TOutput>(topic: string, opts: Rabbitr.IRpcListenerOptions<TInput, TOutput>, executor?): Bluebird<void> {
    // istanbul ignore next
    if (!this.connectionPromise.isFulfilled()) {
      // delay until ready
      return this.whenReady().then(() =>
        this.rpcListener(topic, opts, executor)
      );
    }

    var rpcQueue = this._rpcQueueName(topic);

    this.log(`has rpcListener for ${topic}`);

    this.on(rpcQueue, (envelopedMessage: Rabbitr.IMessage<RPCRequestEnvelope<TInput>>): Bluebird<void> => {
      const envelope = envelopedMessage.data;

      // discard expired messages
      const now = new Date().getTime();
      if (now > envelope.expiration) {
        return Bluebird.resolve();
      }

      const message: Rabbitr.IMessage<TInput> = objectAssign({}, envelopedMessage, {
        data: envelope.d,
        isRPC: true,
        responseHeaders: {},
      });

      return this.useMiddleware(message, executor.bind(null, message))
        .catch(
          // TODO - investigate why bluebird wraps the error here
          //   with an object
          bluebirdUnwrapRejection
        )
        .then<any>( // sanitize errors
          response => {
            this.log(`${yellow('rpcListener')} responding to topic ${cyan(topic)} with`, response);
            return {response};
          }, error => {
            this.log(`${yellow('rpcListener')} on topic ${cyan(topic)} ${red('hit error')}`, error);

            var isError = error instanceof Error;
            var errJSON = isError ?
              stringifyError(error) :
              stringify(error);

            return {
              error: errJSON,
              isError,
            };
          }
        )
        .then(data => { // send the response
          this._publishChannel.sendToQueue(
            // doesn't need wrapping in this.formatName as the rpcExec function
            //   already formats the return queue name as required
            envelope.returnQueue,
            new Buffer(stringify(data)),
            {
              contentType: 'application/json',
              headers: message.responseHeaders,
            }
          );
        });
        // TODO - log uncaught errors at this stage?
        //   bluebird will do it anyway.
    });

    return this.subscribe(rpcQueue,
      objectAssign({}, opts, {
        skipMiddleware: true,
        durable: false,
      })
    );
  }

  // #region middleware
  private middlewareFn = new Array<Rabbitr.Middleware>();

  middleware(fn: Rabbitr.Middleware): void {
    this.middlewareFn.push(fn);
  }

  private useMiddleware<T>(message: Rabbitr.IMessage<any>, next: () => T | PromiseLike<T>): Bluebird<T> {
    return Bluebird.try(
      this.middlewareFn.reduce<typeof next>(function(next, middlewareFn) {
        return middlewareFn.bind(null, message, next) as typeof next;
      }, next)
    );
  }
  // #endregion middleware
};

declare module Rabbitr {
  /** you MUST provide a 'url' rather than separate 'host', 'password', 'vhost' now */
  export interface IOptions {
    url: string;
    log?: (...args: string[]) => void;

    /** preffixed to all queue names - useful for environment and app names etc */
    queuePrefix?: string;

    /** called once the connection is ready but before anything is bound (allows for ORM setup etc) */
    setup?: () => void | PromiseLike<void>;
    connectionOpts?: {
      heartbeat?: boolean;
    };
    ackWarningTimeout?: number;
    autoAckOnTimeout?: string;
    defaultRPCExpiry?: number;
  }

  export type IEventListener<TData> =
    ((message: IMessage<TData>) => void | PromiseLike<void>);

  export interface Headers { [header: string]: string; }

  export interface IRpcExecOptions {
    timeout?: number;
    headers?: any; // Headers;
  }
  export interface IRpcListenerOptions<TInput, TOutput> {
    middleware?: Function[];
    prefetch?: number;
  }
  export type IRpcListenerExecutor<TInput, TOutput> =
    ((message: IMessage<TInput>) => TOutput | PromiseLike<TOutput>);

  export interface ISubscribeOptions {
    prefetch?: number;
    skipMiddleware?: boolean;
    durable?: boolean;
  }
  export interface ISendOptions {
    headers?: any; // Headers;
  }
  export interface ISetTimerOptions {
    headers?: any; // Headers;
  }

  export interface IMessage<TData> {
    topic: string;
    channel: amqplib.Channel;
    data: TData;
    headers: { [header: string]: string; };

    send(topic: string, data: any, opts?: Rabbitr.ISendOptions): Bluebird<void>;
    send<TInput>(topic: string, data: TInput, opts?: Rabbitr.ISendOptions): Bluebird<void>;

    rpcExec(topic: string, data: any): Bluebird<any>;
    rpcExec(topic: string, data: any, opts: Rabbitr.IRpcExecOptions): Bluebird<any>;
    rpcExec<TInput, TOutput>(topic: string, data: TInput, opts?: Rabbitr.IRpcExecOptions): Bluebird<TOutput>;

    isRPC: boolean;
    /** only for rpc: message headers to be sent back with the response */
    responseHeaders?: {
      [header: string]: string;
    };
  }

  export interface MiddlewareCallback {
    (): Bluebird<any | void>;
  }
  export interface Middleware {
    (fn: (message: IMessage<any>, next: MiddlewareCallback) => PromiseLike<any | void>): void;
  }
}

export = Rabbitr;
