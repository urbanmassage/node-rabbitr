import async = require('async');
import chalk = require('chalk');
import {EventEmitter} from 'events';
import amqplib = require('amqplib/callback_api');
import objectAssign = require('object-assign');
import shortId = require('shortid');

const debug = require('debug')('rabbitr');

const DEFAULT_RPC_EXPIRY = 15000; // 15 seconds

// istanbul ignore next
if (parseFloat(process.version.match(/^v(\d+\.\d+)/)[1]) < 0.4) {
  // Monkey-patch :(
  // https://github.com/nodejs/node-v0.x-archive/issues/5110
  Buffer.prototype.toJSON = function() {
    return { type: 'Buffer', data: Array.prototype.slice.call(this, 0) };
  };
}

function stringify(obj: any): string {
  return JSON.stringify(obj);
}

// helper function to properly stringify an error object
function stringifyError(err, filter?, space?) {
  var plainObject = {
    stack: err.stack,
  };
  Object.getOwnPropertyNames(err).forEach(function(key) {
    plainObject[key] = err[key];
  });
  return JSON.stringify(plainObject, filter, space);
}

function parse(json: string): any {
  return JSON.parse(json, function(key, value) {
    return value && value.type === 'Buffer'
      ? new Buffer(value.data)
      : value;
  });
}

const noop = (): void => void 0;
const call = (cb: Function) => cb();

class TimeoutError extends Error {
  topic: string;
  name = 'TimeoutError';
  constructor(details: { topic?: string } = {}) {
    super();
    this.topic = details.topic;
    this.message = `RPC request timed out on topic ${this.topic}`;
    (Error as any).captureStackTrace(this, this.constructor)
  }
}

let HAS_WARNED_ABOUT_V8_BREAKING_CHANGE = false;

class Rabbitr extends EventEmitter {
  opts: Rabbitr.IOptions;

  protected ready = false;
  protected doneSetup = false;
  protected connected = false;

  middleware = new Array<Rabbitr.Middleware>();

  protected connection: amqplib.Connection;

  constructor(opts: Rabbitr.IOptions) {
    super();

    if (!HAS_WARNED_ABOUT_V8_BREAKING_CHANGE) {
      console.warn('Rabbitr has a major breaking change in version 8 - rpcListener queues are no longer durable. You will need to remove all rpcListener queues from RabbitMQ during deployment.')
      HAS_WARNED_ABOUT_V8_BREAKING_CHANGE =  true;
    }

    this.opts = objectAssign(<Rabbitr.IOptions>{
      url: '',
      queuePrefix: '',
      setup: call,
      ackWarningTimeout: 5000,
      autoAckOnTimeout: null,
      defaultRPCExpiry: DEFAULT_RPC_EXPIRY,
    }, opts);
    this.opts.connectionOpts = objectAssign({
      heartbeat: 1
    }, opts && opts.connectionOpts || {});

    // istanbul ignore next
    if (!this.opts.url) {
      throw new Error('Missing `url` in Rabbitr options');
    }

    this._openChannels = [];

    this._connect();
  }

  private _openChannels: amqplib.Channel[];

  private _timerChannel: amqplib.Channel;
  private _publishChannel: amqplib.Channel;
  private _rpcReturnChannel: amqplib.Channel;
  _cachedChannel: amqplib.Channel;

  private _connect() {
    debug('#connect');

    debug('using connection url', this.opts.url);

    amqplib.connect(this.opts.url, this.opts.connectionOpts, (err: Error, conn: amqplib.Connection): void => {
      // istanbul ignore next
      if (err) {
        throw err;
      }

      // make sure to close the connection if the process terminates
      let close = () => conn.close();
      process.once('SIGINT', close);

      conn.on('close', () => {
        process.removeListener('SIGINT', close);
        throw new Error('Disconnected from RabbitMQ');
      });

      conn.createChannel((err: Error, channel: amqplib.Channel): void => {
        // istanbul ignore next
        if (err) {
          throw err;
        }

        this._timerChannel = channel;
        this._publishChannel = channel;
        this._cachedChannel = channel;

        this._openChannels.push(channel);

        conn.createChannel((err: Error, channel: amqplib.Channel): void => {
          // istanbul ignore next
          if (err) {
            throw err;
          }

          this._rpcReturnChannel = channel;

          this._openChannels.push(channel);

          // cache the connection and do all the setup work
          this.connection = conn;
          this.connected = true;

          // istanbul ignore next
          if (this.doneSetup) {
            this._afterSetup();
          } else {
            this.opts.setup((err: Error) => {
              // istanbul ignore next
              if (err) throw err;

              this.doneSetup = true;

              this._afterSetup();
            });
          }
        });
      });
    });
  }

  private _afterSetup() {
    this.ready = true;

    debug('ready and has ready queue size', this.readyQueue.length);

    while (this.readyQueue.length) {
      // istanbul ignore next
      this.readyQueue.shift()();
    }
  }

  private readyQueue: Function[] = [];

  // istanbul ignore next
  public whenReady(callback: Function) {
    if (this.ready) return callback();
    this.readyQueue.push(callback);
  }

  private _formatName(name: string) {
    // istanbul ignore next
    if (this.opts.queuePrefix) {
      name = this.opts.queuePrefix + '.' + name;
    }

    return name;
  }

  // method to destroy anything for this instance of rabbitr
  destroy(cb?: Rabbitr.ErrorCallback): void {
    debug('destroying');
    async.each(this._openChannels, (channel, next) => {
      channel.close(err => {
        // istanbul ignore next
        if (err) {
          debug('Error while closing connection', err);
        } else {
          debug('channel closed');
        }
        next(err);
      });
    }, err => {
      // istanbul ignore next
      if (err) {
        if (cb) cb(err);
        return;
      }

      this.connection.close(err => {
        // istanbul ignore next
        if (err) {
          debug('Error while closing connection', err);
          if (cb) cb(err);
          return;
        }
        debug('connection closed');
        this.removeAllListeners();
        if (cb) cb(null);
      });
    });
  }

  // standard pub/sub stuff

  send(topic: string, data: any, cb?: (err?: Error | any) => void, opts?: Rabbitr.ISendOptions): void;
  send<TInput>(topic: string, data: TInput, cb?: (err?: Error | any) => void, opts?: Rabbitr.ISendOptions): void;

  send<TInput>(topic: string, data: TInput, cb?: (err?: Error | any) => void, opts?: Rabbitr.ISendOptions): void {
    // istanbul ignore next
    if (!this.ready) {
      // delay until ready
      return this.whenReady(() => {
        this.send(topic, data, cb, opts);
      });
    }

    debug(chalk.yellow('send'), topic, data, opts);

    this._publishChannel.assertExchange(this._formatName(topic), 'topic', {}, () => {
      this._publishChannel.publish(this._formatName(topic), '*', new Buffer(stringify(data)), {
        contentType: 'application/json'
      });

      if (cb) cb(null);
    });
  }

  on(topic: string, cb: (data: Rabbitr.IMessage<any>) => void): this;
  on<TData>(topic: string, cb: (data: Rabbitr.IMessage<TData>) => void): this;

  /** @private */
  on(topic: string, cb: (data: Rabbitr.IEnvelopedMessage<any>) => void): this;

  subscribe(topic: string, cb?: Rabbitr.Callback<any>): void;
  subscribe(topic: string, opts?: Rabbitr.ISubscribeOptions, cb?: Rabbitr.Callback<any>): void;
  subscribe<TMessage>(topic: string, cb?: Rabbitr.Callback<TMessage>): void;
  subscribe<TMessage>(topic: string, opts: Rabbitr.ISubscribeOptions, cb: Rabbitr.Callback<TMessage>): void;

  subscribe<TMessage>(topic: string, opts?: Rabbitr.ISubscribeOptions, cb?: Rabbitr.ErrorCallback): void {
    // istanbul ignore next
    if (!cb) {
      cb = <any>opts;
      opts = null;
    }

    // istanbul ignore next
    if (!this.ready) {
      // delay until ready
      return this.whenReady(() => {
        this.subscribe(topic, opts, cb);
      });
    }

    const options: Rabbitr.ISubscribeOptions = opts;

    debug(chalk.cyan('subscribe'), topic, options);

    this.connection.createChannel((err: Error, channel: amqplib.Channel): void => {
      // istanbul ignore next
      if (err) {
        this.emit('error', err);
        if (cb) cb(err);
        return;
      }

      this._openChannels.push(channel);

      channel.assertQueue(this._formatName(topic), objectAssign({
        durable: true,
      }, options), (err, ok) => {
        // istanbul ignore next
        if (err) {
          if (cb) cb(err);
          return;
        }

        channel.prefetch(options ? options.prefetch || 1 : 1);

        const processMessage = (msg: any) => {
          if (!msg) return;

          var data = msg.content.toString();
          if (msg.properties.contentType === 'application/json') {
            data = parse(data);
          }

          debug('got', topic, data);

          var acked = false;

          var ackedTimer = setTimeout(() => {
            this.emit('warning', {
              type: 'ack.timeout',
              queue: topic,
              message: data
            });

            if (this.opts.autoAckOnTimeout === 'acknowledge') {
              acked = true;
              channel.ack(msg);
            } else if (this.opts.autoAckOnTimeout === 'reject') {
              acked = true;
              channel.nack(msg);
            }
          }, this.opts.ackWarningTimeout);

          const message: Rabbitr.IMessage<TMessage> = {
            send: (topic, data, cb?, opts?) => this.send(topic, data, cb, opts),
            rpcExec: (topic, data, opts, cb?) => this.rpcExec(topic, data, opts, cb),
            topic,
            data,
            channel,
            ack() {
              debug('acknowledging message', topic, data);

              if (acked) return;
              acked = true;
              clearTimeout(ackedTimer);

              channel.ack(msg);
            },
            reject() {
              debug('rejecting message', topic, data);

              if (acked) return;
              acked = true;
              clearTimeout(ackedTimer);

              channel.nack(msg);
            }
          };

          const skipMiddleware = options && options.skipMiddleware || false;
          if (skipMiddleware) {
            return this.emit(topic, message);
          }

          this._runMiddleware(message, (middlewareErr: Error) => {
            // TODO - how to handle common error function thing for middleware?
            this.emit(topic, message);
          });
        };

        channel.consume(this._formatName(topic), processMessage, {}, (err: Error/*, ok*/) => {
          // istanbul ignore next
          if (err) {
            this.emit('error', err);
            if (cb) cb(err);
            return;
          }

          if (cb) cb(null);
        });
      });
    });
  }

  bindExchangeToQueue(exchange: string, queue: string, cb?: Rabbitr.ErrorCallback) {
    // istanbul ignore next
    if (!this.ready) {
      // delay until ready
      return this.whenReady(() => {
        this.bindExchangeToQueue(exchange, queue, cb);
      });
    }

    debug(chalk.cyan('bindExchangeToQueue'), exchange, queue);

    this.connection.createChannel((err, channel) => {
      // istanbul ignore next
      if (err) {
        this.emit('error', err);
        if (cb) cb(err);
        return;
      }

      channel.assertQueue(this._formatName(queue));
      channel.assertExchange(this._formatName(exchange), 'topic');

      channel.bindQueue(this._formatName(queue), this._formatName(exchange), '*', {}, (err, ok) => {
        // istanbul ignore next
        if (err) {
          this.emit('error', err);
          if (cb) cb(err);
          return;
        }

        channel.close(cb);
      });
    });
  };

  // timed queue stuff
  private _timerQueueName(topic: string, uniqueID: string): string {
    return 'dlq.' + topic + '.' + uniqueID;
  }

  setTimer<TData>(topic: string, uniqueID: string, data: TData, ttl: number, cb?: Rabbitr.ErrorCallback) {
    // istanbul ignore next
    if (!this.ready) {
      // delay until ready
      return this.whenReady(() => {
        this.setTimer(topic, uniqueID, data, ttl, cb);
      });
    }

    var timerQueue = this._timerQueueName(topic, uniqueID);

    debug(chalk.yellow('setTimer'), topic, uniqueID, data);

    this._timerChannel.assertQueue(this._formatName(timerQueue), {
      durable: true,
      deadLetterExchange: this._formatName(topic),
      arguments: {
        'x-dead-letter-routing-key': '*'
      },
      expires: (ttl + 1000)
    }, err => {
      // istanbul ignore next
      if (err) {
        this.emit('error', err);
        if (cb) cb(err);
        return;
      }

      this._timerChannel.sendToQueue(this._formatName(timerQueue), new Buffer(stringify(data)), {
        contentType: 'application/json',
        // TODO - should we do anything with this?
        expiration: ttl + '',
      });

      process.nextTick(function() {
        if (cb) cb(null);
      });
    });
  }

  clearTimer(topic: string, uniqueID: string, cb?: Rabbitr.ErrorCallback) {
    // istanbul ignore next
    if (!this.ready) {
      // delay until ready
      return this.whenReady(() => {
        this.clearTimer(topic, uniqueID, cb);
      });
    }

    var timerQueue = this._timerQueueName(topic, uniqueID);

    debug(chalk.yellow('clearTimer'), timerQueue);

    try {
      // For some reason we get an error thrown here.
      // TODO - investigate
      this._timerChannel.deleteQueue(timerQueue, {}, (err: Error) => {
        if (cb) cb(err);
      });
    } // istanbul ignore next
    catch (err) {
      if (cb) cb(err);
    }
  }

  // rpc stuff
  private _rpcQueueName(topic: string): string {
    return 'rpc.' + topic;
  }

  rpcExec(topic: string, data: any, cb?: Rabbitr.Callback<any>): void;
  rpcExec(topic: string, data: any, opts: Rabbitr.IRpcExecOptions, cb?: Rabbitr.Callback<any>): void;
  rpcExec<TInput, TOutput>(topic: string, data: TInput, cb?: Rabbitr.Callback<TOutput>): void;
  rpcExec<TInput, TOutput>(topic: string, data: TInput, opts: Rabbitr.IRpcExecOptions, cb: Rabbitr.Callback<TOutput>): void;

  rpcExec<TInput, TOutput>(topic: string, data: TInput, opts: Rabbitr.IRpcExecOptions, cb?: Rabbitr.Callback<TOutput>) {
    // istanbul ignore next
    if (!this.ready) {
      // delay until ready
      return this.whenReady(() => {
        this.rpcExec(topic, data, opts, cb);
      });
    }

    // istanbul ignore next
    if ('function' === typeof opts) {
      // shift arguments
      cb = <Rabbitr.Callback<TOutput>>opts;
      opts = <Rabbitr.IRpcExecOptions>{};
    }

    // this will send the data down the topic and then open up a unique return queue
    const rpcQueue = this._rpcQueueName(topic);

    const unique = shortId.generate() + '_' + ((Math.round(new Date().getTime() / 1000) + '').substr(5));
    const returnQueueName = rpcQueue + '.return.' + unique;

    const now = new Date().getTime();

    // bind the response queue
    let processed = false;

    const channel = this._rpcReturnChannel;

    channel.assertQueue(this._formatName(returnQueueName), {
      exclusive: true,
      expires: (this.opts.defaultRPCExpiry * 1 + 1000),
      durable: false,
    });

    debug('using rpc return queue "%s"', chalk.cyan(returnQueueName));
    const cleanup = () => {
      // delete the return queue and close exc channel
      try {
        channel.deleteQueue(this._formatName(returnQueueName), noop);
      }
      // istanbul ignore next
      catch (e) {
        console.log('rabbitr cleanup exception', e);
      }
    };

    // set a timeout
    const timeoutMS = (opts.timeout || this.opts.defaultRPCExpiry || DEFAULT_RPC_EXPIRY) * 1;
    let timeout = setTimeout(function() {
      debug('request timeout firing for', rpcQueue, 'to', returnQueueName);

      cb(new TimeoutError({ topic: rpcQueue }), null);

      cleanup();
    }, timeoutMS);

    const processMessage = (msg: any) => {
      if (!msg) return;

      let data = msg.content.toString();
      if (msg.properties.contentType === 'application/json') {
        data = parse(data);
      }

      if (processed) {
        cleanup();
        return;
      }
      processed = true;

      clearTimeout(timeout);

      let error = data.error;
      const response: TOutput = data.response;

      if (error) {
        error = JSON.parse(error);
        if (data.isError) {
          var err: any = new Error(error.message);
          Object.keys(error).forEach(function(key) {
            if (err[key] !== error[key]) {
              err[key] = error[key];
            }
          });
          error = err;
        }
      }

      if (cb) cb(error, response);

      cleanup();
    };

    channel.consume(this._formatName(returnQueueName), processMessage, {
      noAck: true
    }, err => {
      // istanbul ignore next
      if (err) {
        this.emit('error', err);
        if (cb) cb(err, null);
        return;
      }

      // send the request now
      const obj = {
        d: data,
        returnQueue: this._formatName(returnQueueName),
        expiration: now + timeoutMS
      };
      this._publishChannel.sendToQueue(this._formatName(rpcQueue), new Buffer(stringify(obj)), {
        contentType: 'application/json',
        expiration: timeoutMS + ''
      });
    });
  }

  rpcListener(topic: string, executor: Rabbitr.IRpcListenerExecutor<any, any>): void;
  rpcListener(topic: string, opts: Rabbitr.IRpcListenerOptions<any, any>, executor: Rabbitr.IRpcListenerExecutor<any, any>): void;
  rpcListener<TInput, TOutput>(topic: string, executor: Rabbitr.IRpcListenerExecutor<TInput, TOutput>): void;
  rpcListener<TInput, TOutput>(topic: string, opts: Rabbitr.IRpcListenerOptions<TInput, TOutput>, executor: Rabbitr.IRpcListenerExecutor<TInput, TOutput>): void;

  rpcListener<TInput, TOutput>(topic: string, opts: Rabbitr.IRpcListenerOptions<TInput, TOutput>, executor?: Rabbitr.IRpcListenerExecutor<TInput, TOutput>): void {
    // istanbul ignore next
    if (!this.ready) {
      // delay until ready
      return this.whenReady(() => {
        this.rpcListener(topic, opts, executor);
      });
    }

    // istanbul ignore next
    if ('function' === typeof opts) {
      // shift arguments
      executor = <Rabbitr.IRpcListenerExecutor<TInput, TOutput>>opts;
      opts = <Rabbitr.IRpcListenerOptions<TInput, TOutput>>{};
    }

    var rpcQueue = this._rpcQueueName(topic);

    (<any>opts).skipMiddleware = true;
    (<any>opts).durable = false;
    this.subscribe(rpcQueue, opts, function() {});

    debug('has rpcListener for', topic);

    this.on(rpcQueue, (envelope: Rabbitr.IEnvelopedMessage<TInput>) => {
      const dataEnvelope = envelope.data;

      const now = new Date().getTime();

      if (now > dataEnvelope.expiration) {
        envelope.ack();
        return;
      }

      const message: Rabbitr.IMessage<TInput> = <Rabbitr.IEnvelopedMessage<TInput> & Rabbitr.IMessage<TInput>>envelope;
      message.data = dataEnvelope.d;

      // support for older clients - is this needed?
      message.queue = {
        shift: message.ack,
      };

      this._runMiddleware(message, (middlewareErr: Error) => {
        // TODO - how to handle common error function thing for middleware?
        var _cb: Rabbitr.Callback<TOutput> = (err?: Error, response?: TOutput): void => {
          // istanbul ignore next
          if (err) {
            debug(`${chalk.cyan('rpcListener')} ${chalk.red('hit error')}`, err);
          } else {
            debug(`${chalk.cyan('rpcListener')} responding to topic ${topic} with`, response);
          }

          // ack here - this will get ignored if the executor has acked or nacked already anyway
          message.ack();

          var isError = err instanceof Error;
          var errJSON = isError ?
            stringifyError(err) :
            JSON.stringify(err);

          // doesn't need wrapping in this.formatName as the rpcExec function already formats the return queue name as required
          this._publishChannel.sendToQueue(dataEnvelope.returnQueue, new Buffer(stringify({
            error: err ? errJSON : undefined,
            isError: isError,
            response: response,
          })), {
              contentType: 'application/json'
            });
        };

        function _runExecutor() {
          executor(message, _cb);
        }

        if (!opts.middleware || opts.middleware.length === 0) {
          // no middleware specified for this listener
          return _runExecutor();
        }

        async.eachSeries(opts.middleware, function(middlewareFunc, next) {
          middlewareFunc(message, _cb, next);
        }, _runExecutor);
      });
    });
  }

  // message middleware support
  use(middlewareFunc: Rabbitr.Middleware) {
    this.middleware.push(middlewareFunc);
  }
  private _runMiddleware(message: Rabbitr.IMessage<any>, next: Rabbitr.ErrorCallback) {
    if (this.middleware.length === 0) return next(null);
    async.eachSeries(this.middleware, (middlewareFunc, next) => {
      middlewareFunc(message, next);
    }, next);
  }
};

declare module Rabbitr {
  /** you MUST provide a 'url' rather than separate 'host', 'password', 'vhost' now */
  export interface IOptions {
    url: string;

    /** preffixed to all queue names - useful for environment and app names etc */
    queuePrefix?: string;

    /** called once the connection is ready but before anything is bound (allows for ORM setup etc) */
    setup?: (done: Rabbitr.ErrorCallback) => void;
    connectionOpts?: {
      heartbeat?: boolean;
    };
    ackWarningTimeout?: number;
    autoAckOnTimeout?: string;
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
    middleware?: Function[];
    prefetch?: number;
  }
  export interface IRpcListenerExecutor<TInput, TOutput> {
    (message: IMessage<TInput>, respond: Callback<TOutput>): void;
  }
  export interface ISubscribeOptions {
    prefetch?: number;
    skipMiddleware?: boolean;
    durable?: boolean;
  }
  export interface ISendOptions {
  }

  export interface IMessage<TData> {
    ack(): void;
    reject(): void;

    topic: string;
    channel: amqplib.Channel;
    data: TData;

    send(topic: string, data: any, cb?: (err?: Error | any) => void, opts?: Rabbitr.ISendOptions): void;
    send<TInput>(topic: string, data: TInput, cb?: (err?: Error | any) => void, opts?: Rabbitr.ISendOptions): void;
    rpcExec(topic: string, data: any, cb?: Rabbitr.Callback<any>): void;
    rpcExec(topic: string, data: any, opts: Rabbitr.IRpcExecOptions, cb?: Rabbitr.Callback<any>): void;
    rpcExec<TInput, TOutput>(topic: string, data: TInput, cb?: Rabbitr.Callback<TOutput>): void;
    rpcExec<TInput, TOutput>(topic: string, data: TInput, opts: Rabbitr.IRpcExecOptions, cb: Rabbitr.Callback<TOutput>): void;

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

  export interface Middleware {
    // TODO - better annotation
    (message: IMessage<any>, cb: Function, next?: Function): void;
  }
}

export = Rabbitr;
