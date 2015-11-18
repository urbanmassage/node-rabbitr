import async = require('async');
import chalk = require('chalk');
import {EventEmitter} from 'events';
import amqplib = require('amqplib/callback_api');

const debug = require('debug')('rabbitr');
const extend = require('util')._extend;
const shortId = require('shortid');

const DEFAULT_RPC_EXPIRY = 15000; // 15 seconds

function noop() { return void 0; };

function hasProp(obj: Object, prop: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

class TimeoutError extends Error {
  topic: string;
  constructor(details: { topic?: string } = {}) {
    super('Request timed out');
    this.topic = details.topic;
  }
}

class Rabbitr extends EventEmitter {
  opts: Rabbitr.IOptions;

  protected ready = false;
  protected doneSetup = false;
  protected connected = false;
  subscribeQueue: {
    topic: string,
    opts?: Rabbitr.ISubscribeOptions,
    cb: ErrorCallback,
  }[] = [];
  bindingsQueue: {
    exchange: string,
    queue: string,
    cb: ErrorCallback,
  }[] = [];
  sendQueue = [];
  setTimerQueue = [];
  clearTimerQueue = [];
  rpcListenerQueue = [];
  rpcExecQueue: {
    topic: string,
    data: any,
    opts: Rabbitr.IRpcExecOptions,
    cb: Rabbitr.Callback<any>
  }[] = [];
  middleware = [];

  protected connection: amqplib.Connection;

  constructor(opts: Rabbitr.IOptions) {
    super();

    // you MUST provide a 'url' rather than separate 'host', 'password', 'vhost' now
    this.opts = extend({
      queuePrefix: '', // preffixed to all queue names - useful for environment and app names etc
      setup(done) { done(); }, // called once the connection is ready but before anything is bound (allows for ORM setup etc)
      connectionOpts: extend({
        heartbeat: 1
      }, opts && opts.connectionOpts || {}),
      ackWarningTimeout: 5000,
      autoAckOnTimeout: null,
      defaultRPCExpiry: DEFAULT_RPC_EXPIRY
    }, opts);

    Object.keys(this.opts).forEach(key => {
      if (hasProp(opts, key) && opts[key]) {
        this.opts[key] = opts[key];
      }
    });

    this._connect();
  }

  private _timerChannel;
  private _publishChannel;
  _cachedChannel;

  private _connect() {
    debug('#connect');

    debug('using connection url', this.opts.url);

    amqplib.connect(this.opts.url, this.opts.connectionOpts, (err: Error, conn: amqplib.Connection): void => {
      if (err) {
        throw err;
      }

      // make sure to close the connection if the process terminates
      process.once('SIGINT', conn.close.bind(conn));

      conn.on('close', () => {
        throw new Error('Disconnected from RabbitMQ');
      });

      conn.createChannel((err: Error, channel: amqplib.Channel): void => {
        if (err) {
          throw err;
        }

        this._timerChannel = channel;
        this._publishChannel = channel;
        this._cachedChannel = channel;

        // cache the connection and do all the setup work
        this.connection = conn;
        this.connected = true;

        if (this.doneSetup) {
          this._afterSetup();
        } else {
          this.opts.setup((err) => {
            if (err) throw err;

            this.doneSetup = true;

            this._afterSetup();
          });
        }
      });
    });
  }

  private _afterSetup() {
    this.ready = true;

    debug('ready and has queue sizes', this.subscribeQueue.length, this.bindingsQueue.length, this.rpcListenerQueue.length, this.sendQueue.length, this.rpcExecQueue.length);
    for (var i = 0; i < this.subscribeQueue.length; i++) {
      this.subscribe(
        this.subscribeQueue[i].topic,
        this.subscribeQueue[i].opts,
        this.subscribeQueue[i].cb,
        true
      );
    }
    this.subscribeQueue = [];
    for (var i = 0; i < this.bindingsQueue.length; i++) {
      this.bindExchangeToQueue(this.bindingsQueue[i].exchange, this.bindingsQueue[i].queue, this.bindingsQueue[i].cb, true);
    }
    this.bindingsQueue = [];
    for (var i = 0; i < this.rpcListenerQueue.length; i++) {
      this.rpcListener(this.rpcListenerQueue[i].topic, this.rpcListenerQueue[i].opts, this.rpcListenerQueue[i].executor, true);
    }
    this.rpcListenerQueue = [];

    // send anything in send queue but clear it after
    for (var i = 0; i < this.sendQueue.length; i++) {
      this.send(this.sendQueue[i].topic, this.sendQueue[i].data, this.sendQueue[i].cb, this.sendQueue[i].opts);
    }
    this.sendQueue = [];

    // send anything in setTimer queue but clear it after
    for (var i = 0; i < this.setTimerQueue.length; i++) {
      this.setTimer(this.setTimerQueue[i].topic, this.setTimerQueue[i].uniqueID, this.setTimerQueue[i].data, this.setTimerQueue[i].ttl, this.setTimerQueue[i].cb);
    }
    this.setTimerQueue = [];

    // send anything in clearTimer queue but clear it after
    for (var i = 0; i < this.clearTimerQueue.length; i++) {
      this.clearTimer(this.clearTimerQueue[i].topic, this.clearTimerQueue[i].uniqueID, this.clearTimerQueue[i].cb);
    }
    this.clearTimerQueue = [];

    // send anything in rpcExec queue but clear it after
    for (var i = 0; i < this.rpcExecQueue.length; i++) {
      this.rpcExec(
        this.rpcExecQueue[i].topic,
        this.rpcExecQueue[i].data,
        this.rpcExecQueue[i].opts,
        this.rpcExecQueue[i].cb
      );
    }
    this.rpcExecQueue = [];
  }

  private _formatName(name) {
    if (this.opts.queuePrefix) {
      name = this.opts.queuePrefix + '.' + name;
    }

    return name;
  }

  // standard pub/sub stuff
  send(topic: string, data: any, cb?: Function, opts?: Rabbitr.ISendOptions) {
    if (!this.ready) {
      debug('adding item to send queue');
      return this.sendQueue.push({
        topic,
        data,
        cb,
        opts,
      });
    }

    debug(chalk.yellow('send'), topic, data, opts);

    this._publishChannel.assertExchange(this._formatName(topic), 'topic', {}, () => {
      this._publishChannel.publish(this._formatName(topic), '*', new Buffer(JSON.stringify(data)), {
        contentType: 'application/json'
      });

      if (cb) cb(null);
    });
  }
  subscribe(topic: string, cb?: Rabbitr.ErrorCallback): void;
  subscribe(topic: string, opts?: Rabbitr.ISubscribeOptions, cb?: Rabbitr.ErrorCallback, alreadyInQueue?: boolean): void;
  subscribe(topic: string, opts?, cb?: Rabbitr.ErrorCallback, alreadyInQueue?: boolean): void {
    if (!cb) {
      cb = <Rabbitr.ErrorCallback>opts;
      opts = null;
    }

    if (!alreadyInQueue) {
      debug('adding item to sub queue');
      this.subscribeQueue.push({
        topic,
        opts,
        cb,
      });
    }

    const options: Rabbitr.ISubscribeOptions = opts;

    if (!this.ready) {
      return;
    }

    debug(chalk.cyan('subscribe'), topic, options);

    this.connection.createChannel((err: Error, channel: amqplib.Channel): void => {
      if (err) {
        this.emit('error', err);
        if (cb) cb(err);
        return;
      }

      channel.assertQueue(this._formatName(topic), {}, (err, ok) => {
        if (err) {
          return cb(err);
        }

        channel.prefetch(options ? options.prefetch || 1 : 1);

        const processMessage = function processMessage(msg) {
          if (!msg) return;

          var data = msg.content.toString();
          if (msg.properties.contentType === 'application/json') {
            data = JSON.parse(data);
          }

          debug('got', topic, data);

          var acked = false;

          var ackedTimer = setTimeout(() => {
            this.emit('warning', {
              type: 'ack.timeout',
              queue: topic,
              message: data
            });

            if (this.opts.autoAckOnTimeout === Rabbitr.AckTimeoutOption.Acknowledge) {
              acked = true;
              channel.ack(msg);
            } else if (this.opts.autoAckOnTimeout === Rabbitr.AckTimeoutOption.Reject) {
              acked = true;
              channel.nack(msg);
            }
          }, this.opts.ackWarningTimeout);

          var message = {
            topic: topic,
            send: this.send.bind(this),
            rpcExec: this.rpcExec.bind(this),
            data: data,
            channel: channel,
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

          var skipMiddleware = options ? options.skipMiddleware || false : false;

          if (skipMiddleware) {
            return this.emit(topic, message);
          }

          this._runMiddleware(message, (middlewareErr) => {
            // TODO - how to handle common error function thing for middleware?
            this.emit(topic, message);
          });
        }.bind(this);

        channel.consume(this._formatName(topic), processMessage, (err, ok) => {
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
  bindExchangeToQueue(exchange: string, queue: string, cb?: ErrorCallback, alreadyInQueue?: boolean) {
    if (!alreadyInQueue) {
      debug('adding item to bindings queue');
      this.bindingsQueue.push({
        exchange,
        queue,
        cb,
      });
    }

    if (!this.ready) {
      return;
    }

    debug(chalk.cyan('bindExchangeToQueue'), exchange, queue);

    this.connection.createChannel((err, channel) => {
      if (err) {
        this.emit('error', err);
        if (cb) cb(err);
        return;
      }

      channel.assertQueue(this._formatName(queue));
      channel.assertExchange(this._formatName(exchange), 'topic');

      channel.bindQueue(this._formatName(queue), this._formatName(exchange), '*', {}, (err, ok) => {
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
  setTimer(topic: string, uniqueID, data, ttl, cb?: Function) {
    if (!this.ready) {
      debug('adding item to setTimer queue');
      this.setTimerQueue.push({
        topic: topic,
        uniqueID: uniqueID,
        data: data,
        ttl: ttl,
        cb: cb
      });

      return;
    }

    var timerQueue = this._timerQueueName(topic, uniqueID);

    debug(chalk.yellow('setTimer'), topic, uniqueID, data);

    this._timerChannel.assertQueue(this._formatName(timerQueue), {
      durable: true,
      deadLetterExchange: this._formatName(topic),
      deadLetterRoutingKey: '*',
      expires: (ttl + 1000)
    }, (err) => {
      if (err) {
        this.emit('error', err);
        if (cb) cb(err);
        return;
      }

      this._timerChannel.sendToQueue(this._formatName(timerQueue), new Buffer(JSON.stringify(data)), {
        contentType: 'application/json',
        expiration: ttl
      }, (err) => {
        if (err) {
          this.emit('error', err);
          if (cb) cb(err);
          return;
        }

        if (cb) cb(null);
      });
    });
  }
  clearTimer(topic: string, uniqueID, cb: ErrorCallback) {
    if (!this.ready) {
      debug('adding item to clearTimer queue');
      this.clearTimerQueue.push({
        topic: topic,
        uniqueID: uniqueID,
        cb: cb
      });

      return;
    }

    var timerQueue = this._timerQueueName(topic, uniqueID);

    debug(chalk.yellow('clearTimer'), timerQueue);

    this._timerChannel.deleteQueue(timerQueue, {}, (err: Error) => {
      if (cb) cb(err);
    });
  }

  // rpc stuff
  private _rpcQueueName(topic: string): string {
    return 'rpc.' + topic;
  }
  rpcExec(topic: string, data: any, cb?: Rabbitr.Callback<any>): void;
  rpcExec(topic: string, data: any, opts: Rabbitr.IRpcExecOptions, cb?: Rabbitr.Callback<any>): void;

  rpcExec(topic: string, data: any, opts, cb?) {
    if ('function' === typeof opts) {
      // shift arguments
      cb = <Rabbitr.Callback<any>>opts;
      opts = <Rabbitr.IRpcExecOptions>{};
    }

    if (!this.ready) {
      debug('adding item to rpcExec queue');
      this.rpcExecQueue.push({
        topic,
        data,
        opts,
        cb,
      });

      return;
    }

    // this will send the data down the topic and then open up a unique return queue
    var rpcQueue = this._rpcQueueName(topic);

    var unique = shortId.generate() + '_' + ((Math.round(new Date().getTime() / 1000) + '').substr(5));
    var returnQueueName = rpcQueue + '.return.' + unique;

    var now = new Date().getTime();

    // bind the response queue
    var processed = false;

    this.connection.createChannel((err, channel) => {
      if (err) {
        this.emit('error', err);
        if (cb) cb(err);
        return;
      }

      channel.assertQueue(this._formatName(returnQueueName), {
        exclusive: true,
        expires: (this.opts.defaultRPCExpiry * 1 + 1000)
      });

      debug('using rpc return queue "%s"', chalk.cyan(returnQueueName));
      const cleanup = function cleanup() {
        // delete the return queue and close exc channel
        try {
          channel.deleteQueue(this._formatName(returnQueueName), function() {
            channel.close(noop);
          });
        } catch (e) {
          console.log('rabbitr cleanup exception', e);
        }
      }.bind(this);

      // set a timeout
      const timeoutMS = (opts.timeout || this.opts.defaultRPCExpiry || DEFAULT_RPC_EXPIRY) * 1;
      var timeout = setTimeout(function() {
        debug('request timeout firing for', rpcQueue, 'to', returnQueueName);

        cb(new TimeoutError({ topic: rpcQueue }));

        cleanup();
      }, timeoutMS);

      const processMessage = function processMessage(msg) {
        if (!msg) return;

        var data = msg.content.toString();
        if (msg.properties.contentType === 'application/json') {
          data = JSON.parse(data);
        }

        if (processed) {
          cleanup();
          return;
        }
        processed = true;

        clearTimeout(timeout);

        var error = data.error;
        var response = data.response;

        if (error) {
          error = JSON.parse(error);
          if (data.isError) {
            var err = new Error(error.message);
            Object.keys(error).forEach(function(key) {
              if (err[key] !== error[key]) {
                err[key] = error[key];
              }
            });
            error = err;
          }
        }

        cb(error, response);

        cleanup();
      }.bind(this);

      channel.consume(this._formatName(returnQueueName), processMessage, {
        noAck: true
      }, (err) => {
        if (err) {
          this.emit('error', err);
          if (cb) cb(err);
          return;
        }

        // send the request now
        const obj = {
          d: data,
          returnQueue: this._formatName(returnQueueName),
          expiration: now + timeoutMS
        };
        this._publishChannel.sendToQueue(this._formatName(rpcQueue), new Buffer(JSON.stringify(obj)), {
          contentType: 'application/json',
          expiration: timeoutMS
        });
      });
    });
  }

  // rpcListener(topic: string, executor: Function, alreadyInQueue?: boolean): void;
  rpcListener(topic: string, opts: Rabbitr.IRpcListenerOptions, executor?: Function, alreadyInQueue?: boolean): void {
    if ('function' === typeof opts) {
      // shift arguments
      alreadyInQueue = !!executor;
      executor = <Function>opts;
      opts = <Rabbitr.IRpcListenerOptions>{};
    }

    if (!alreadyInQueue) {
      debug('adding item to rpcListener queue');
      this.rpcListenerQueue.push({
        topic: topic,
        executor: executor,
        opts: opts
      });
    }

    if (!this.ready) {
      return;
    }

    var rpcQueue = this._rpcQueueName(topic);

    (<any>opts).skipMiddleware = true;
    this.subscribe(rpcQueue, opts);

    debug('has rpcListener for', topic);

    this.on(rpcQueue, (message) => {
      var dataEnvelope = message.data;
      message.data = dataEnvelope.d;

      var now = new Date().getTime();

      if (now > dataEnvelope.expiration) {
        message.ack();
        return;
      }

      // support for older clients - is this needed?
      message.queue = {
        shift: message.ack,
      };

      this._runMiddleware(message, (middlewareErr) => {
        // TODO - how to handle common error function thing for middleware?
        var _cb: Rabbitr.Callback<any> = (err?, response?): void => {
          if (err) {
            debug(chalk.cyan('rpcListener') + ' ' + chalk.red('hit error'), err);
          }

          // ack here - this will get ignored if the executor has acked or nacked already anyway
          message.ack();

          var isError = err instanceof Error;
          var errJSON = isError ? JSON.stringify(err, Object.keys(err).concat(['name', 'type', 'arguments', 'stack', 'message'])) : JSON.stringify(err);

          // doesn't need wrapping in this.formatName as the rpcExec function already formats the return queue name as required
          this._publishChannel.sendToQueue(dataEnvelope.returnQueue, new Buffer(JSON.stringify({
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
  use(middlewareFunc: ErrorCallback) {
    this.middleware.push(middlewareFunc);
  }
  private _runMiddleware(message, next: ErrorCallback) {
    if (this.middleware.length === 0) return next();
    async.eachSeries(this.middleware, (middlewareFunc, next) => {
      middlewareFunc(message, next);
    }, next);
  }
};

module Rabbitr {
  export interface IOptions {
    url: string;
    queuePrefix?: string;
    setup?: (done: ErrorCallback) => void;
    connectionOpts?: {
      heartbeat?: boolean;
    };
    ackWarningTimeout?: number;
    autoAckOnTimeout?: AckTimeoutOption;
    defaultRPCExpiry?: number;
  }

  export enum AckTimeoutOption {
    Acknowledge = <any>'acknowledge',
    Reject = <any>'reject',
  }

  export interface ErrorCallback {
    (err?: Error): void;
  }

  export interface Callback<T> {
    (err?: Error): void;
    (err?: Error, data?: T): void;
  }

  export interface IRpcExecOptions {
    timeout?: number;
  }
  export interface IRpcListenerOptions {
    middleware?: Function[];
  }
  export interface ISubscribeOptions {
    prefetch?: number;
    skipMiddleware?: boolean;
  }
  export interface ISendOptions {
  }
}

export = Rabbitr;
