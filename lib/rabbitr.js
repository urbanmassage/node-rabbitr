var util = require('util');
var async = require('async');
var EventEmitter = require('events').EventEmitter;
var colors = require('colors');
var amqplib = require('amqplib/callback_api');
var debug = require('debug')('rabbitr');
var extend = require('util')._extend;
var shortId = require('shortid');

var kDefaultRPCExpiry = 15000; // 15 seconds

var lock = function(_, cb) { cb(function() { }); }

var Rabbitr = module.exports = function constructor(opts) {
    EventEmitter.call( this );
    
    // you MUST provide a 'url' rather than separate 'host', 'password', 'vhost' now
    var o = this.opts = {
        queuePrefix: '', // preffixed to all queue names - useful for environment and app names etc
        setup: function(done) { done(); }, // called once the connection is ready but before anything is bound (allows for ORM setup etc)
        connectionOpts: {
            heartbeat: 1
        },
        ackWarningTimeout: 5000,
        autoAckOnTimeout: null,
        defaultRPCExpiry: kDefaultRPCExpiry
    };
        
    for (var p in opts) {
        if (!opts.hasOwnProperty(p) || opts[p] == null) continue; // ignore null props on the opts object
        
        o[p] = opts[p];
    }
    
    this.ready = false;
    this.doneSetup = false;
    this.connected = false;
    this.subscribeQueue = [];
    this.bindingsQueue = [];
    this.sendQueue = [];
    this.setTimerQueue = [];
    this.clearTimerQueue = [];
    this.rpcListenerQueue = [];
    this.rpcExecQueue = [];

    this.middleware = [];
    
    var self = this;

    self._queueChannelCache = {};
    //self._exchangeChannelCache = {};
    self.subscribes = {}; // is this still necessary??

    // stored as a locally scoped var rather than as a prototype as we don't really want any body else calling this
    var connect = function connect() {
        debug('rabbitr'.cyan, '#connect');

        debug('rabbitr'.cyan, 'using connection url', self.opts.url);

        amqplib.connect(self.opts.url, self.opts.connectionOpts, function(err, conn) {
            if(err) {
                throw err;
            }

            // make sure to close the connection if the process terminates
            process.once('SIGINT', conn.close.bind(conn));

            conn.on('close', function() {
                throw new Error('Disconnected from RabbitMQ');
            });
            /*conn.on('error', function(e) {
                console.log(e);
                throw new Error('Disconnected from RabbitMQ', e);
            });*/

            conn.createChannel(function(err, channel) {
                if(err) {
                    throw err;
                }

                self._timerChannel = channel;
                self._publishChannel = channel;
                self._cachedChannel = channel;

                // cache the connection and do all the setup work
                self.connection = conn;
                self.connected = true;

                var afterSetup = function() {
                    self.ready = true;
                    
                    console.log('rabbitr'.cyan, 'amqp is ready');
                    
                    debug('rabbitr'.cyan, 'is ready and has queue sizes', self.subscribeQueue.length, self.bindingsQueue.length, self.rpcListenerQueue.length, self.sendQueue.length, self.rpcExecQueue.length);
                    for(var i=0; i<self.subscribeQueue.length; i++) {
                        self.subscribe(self.subscribeQueue[i].topic, self.subscribeQueue[i].opts, self.subscribeQueue[i].cb, true);
                    }
                    self.subscribeQueue = [];
                    for(var i=0; i<self.bindingsQueue.length; i++) {
                        self.bindExchangeToQueue(self.bindingsQueue[i].exchange, self.bindingsQueue[i].queue, self.bindingsQueue[i].cb, true);
                    }
                    self.bindingsQueue = [];
                    for(var i=0; i<self.rpcListenerQueue.length; i++) {
                        self.rpcListener(self.rpcListenerQueue[i].topic, self.rpcListenerQueue[i].opts, self.rpcListenerQueue[i].executor, true);
                    }
                    self.rpcListenerQueue = [];
                    
                    // send anything in send queue but clear it after
                    for(var i=0; i<self.sendQueue.length; i++) {
                        self.send(self.sendQueue[i].topic, self.sendQueue[i].data, self.sendQueue[i].cb, self.sendQueue[i].opts);
                    }
                    self.sendQueue = [];
                    
                    // send anything in setTimer queue but clear it after
                    for(var i=0; i<self.setTimerQueue.length; i++) {
                        self.setTimer(self.setTimerQueue[i].topic, self.setTimerQueue[i].uniqueID, self.setTimerQueue[i].data, self.setTimerQueue[i].ttl, self.setTimerQueue[i].cb);
                    }
                    self.setTimerQueue = [];
                    
                    // send anything in clearTimer queue but clear it after
                    for(var i=0; i<self.clearTimerQueue.length; i++) {
                        self.clearTimer(self.clearTimerQueue[i].topic, self.clearTimerQueue[i].uniqueID, self.clearTimerQueue[i].cb);
                    }
                    self.clearTimerQueue = [];
                    
                    // send anything in rpcExec queue but clear it after
                    for(var i=0; i<self.rpcExecQueue.length; i++) {
                        self.rpcExec(self.rpcExecQueue[i].topic, self.rpcExecQueue[i].data, self.rpcExecQueue[i].opts, self.rpcExecQueue[i].cb);
                    }
                    self.rpcExecQueue = [];
                };
                
                if(self.doneSetup) {
                    afterSetup();
                }
                else {
                    self.opts.setup(function(err) {
                        if(err) throw err;
                            
                        self.doneSetup = true;
                            
                        afterSetup();
                    });
                }
            });
        });
    };
    connect();
};
util.inherits(Rabbitr, EventEmitter);

Rabbitr.prototype._formatName = function _formatName(name) {
    var self = this;

    if(self.opts.queuePrefix != '') {
        name = self.opts.queuePrefix + '.' + name;
    }
    
    return name;
};


// standard pub/sub stuff
Rabbitr.prototype.send = function send(topic, data, cb, opts) {
    var self = this;
    
    if(!self.ready) {
        debug('adding item to send queue');
        return self.sendQueue.push({
            topic: topic,
            data: data,
            cb: cb,
            opts: opts
        });
    }
    
    debug('send'.yellow, topic, data, opts);

    self._publishChannel.assertExchange(self._formatName(topic), 'topic', {}, function() {
        self._publishChannel.publish(self._formatName(topic), '*', new Buffer(JSON.stringify(data)), {
            contentType: 'application/json'
        });

        if(cb) cb(null);
    });
};
Rabbitr.prototype.subscribe = function subscribe(topic, opts, cb, alreadyInQueue) {
    var self = this;
    
    if(!cb) {
        cb = opts;
        opts = null;
    }
    
    if(alreadyInQueue != true) {
        debug('adding item to sub queue');
        self.subscribeQueue.push({
            topic: topic,
            opts: opts,
            cb: cb
        });
    }
    
    if(!self.ready) {
        return;
    }
    
    debug('subscribe'.cyan, topic, opts);

    self.connection.createChannel(function(err, channel) {
        if(err) {
            self.emit('error', err);
            if(cb) cb(err);
            return;
        }

        channel.assertQueue(self._formatName(topic), {}, function(err, ok) {
            if(err) {
                return cb(err);
            }

            // should this be arbritrarily hard coded?
            channel.prefetch(opts ? opts.prefetch || 1 : 1);

            var processMessage = function processMessage(msg) {
                if(!msg) return;

                var data = msg.content.toString();
                if(msg.properties.contentType == 'application/json') {
                    data = JSON.parse(data);
                }

                debug('got', topic, data);
            
                var acked = false;

                var ackedTimer = setTimeout(function() {
                    self.emit('warning', {
                        type: 'ack.timeout',
                        queue: topic,
                        message: data
                    });

                    if(self.opts.autoAckOnTimeout === 'acknowledge') {
                        acked = true;
                        messageObject.acknowledge();
                    } 
                    else if(self.opts.autoAckOnTimeout === 'reject') {
                        acked = true;
                        messageObject.reject(true);
                    }
                }, self.opts.ackWarningTimeout);

                var message = {
                    topic: topic,
                    send: self.send.bind(self),
                    rpcExec: self.rpcExec.bind(self),
                    data: data,
                    channel: channel,
                    ack: function() {
                        debug('acknowledging message', topic, data);
                        
                        if(acked) return;
                        acked = true;
                        clearTimeout(ackedTimer);
                        
                        channel.ack(msg);
                    },
                    reject: function() {
                        debug('rejecting message', topic, data);
                        
                        if(acked) return;
                        acked = true;
                        clearTimeout(ackedTimer);
                        
                        channel.nack(msg);
                    }
                };

                var skipMiddleware = opts ? opts.skipMiddleware || false : false;

                if(skipMiddleware) {
                    return self.emit(topic, message);
                }

                self._runMiddleware(message, function(middlewareErr) {
                    // TODO - how to handle common error function thing for middleware?

                    self.emit(topic, message); 
                });
            };

            channel.consume(self._formatName(topic), processMessage, function(err, ok) {
                if(err) {
                    self.emit('error', err);
                    if(cb) cb(err);
                    return;
                }

                if(cb) cb(null);
            });
        });
    });
};
Rabbitr.prototype.bindExchangeToQueue = function bindExchangeToQueue(exchange, queue, cb, alreadyInQueue) {
    var self = this;

    if(alreadyInQueue != true) {
        debug('adding item to bindings queue');
        self.bindingsQueue.push({
            exchange: exchange,
            queue: queue,
            cb: cb
        });
    }

    if(!self.ready) {
        return;
    }
    
    debug('bindExchangeToQueue'.cyan, exchange, queue);

    self.connection.createChannel(function(err, channel) {
        if(err) { 
            self.emit('error', err);
            if(cb) cb(err);
            return;
        }

        channel.assertQueue(self._formatName(queue));
        channel.assertExchange(self._formatName(exchange), 'topic');

        channel.bindQueue(self._formatName(queue), self._formatName(exchange), '*', {}, function(err, ok) {
            if(err) {
                self.emit('error', err);
                if(cb) cb(err);
                return;
            }

            channel.close();

            if(cb) cb(null);
        });
    });
};


// timed queue stuff
Rabbitr.prototype._timerQueueName = function _timerQueueName(topic, uniqueID) {
    return 'dlq.' + topic + '.' + uniqueID;
};
Rabbitr.prototype.setTimer = function setTimer(topic, uniqueID, data, ttl, cb) {
    var self = this;
    
    if(!self.ready) {
        debug('adding item to setTimer queue');
        self.setTimerQueue.push({
            topic: topic,
            uniqueID: uniqueID,
            data: data,
            ttl: ttl,
            cb: cb
        });
        
        return;
    }

    var timerQueue = self._timerQueueName(topic, uniqueID);
    
    debug('setTimer'.yellow, topic, uniqueID, data);

    self._timerChannel.assertQueue(self._formatName(timerQueue), {
        durable: true,
        deadLetterExchange: self._formatName(topic),
        deadLetterRoutingKey: '*',
        expires: (ttl + 1000)
    }, function(err) {
        if(err) { 
            self.emit('error', err);
            if(cb) cb(err);
            return;
        }

        self._timerChannel.sendToQueue(self._formatName(timerQueue), new Buffer(JSON.stringify(data)), {
            contentType: 'application/json',
            expiration: ttl
        }, function(err) {
            if(err) { 
                self.emit('error', err);
                if(cb) cb(err);
                return;
            }

            if(cb) cb(null);
        });
    });
};
Rabbitr.prototype.clearTimer = function clearTimer(topic, uniqueID, cb) {
    var self = this;
    
    if(!self.ready) {
        debug('adding item to clearTimer queue');
        self.clearTimerQueue.push({
            topic: topic,
            uniqueID: uniqueID,
            cb: cb
        });
        
        return;
    }
    
    var timerQueue = self._timerQueueName(topic, uniqueID);
    
    debug('clearTimer'.yellow, timerQueue);

    self._timerChannel.deleteQueue(timerQueue, {}, function(err) {
        if(cb) cb(err);
    });
};


// rpc stuff
Rabbitr.prototype._rpcQueueName = function _rpcQueueName(topic) {
    return 'rpc.' + topic;
};
Rabbitr.prototype.rpcExec = function rpcExec(topic, d, opts, cb) {
    var self = this;
    
    if(!self.ready) {
        debug('adding item to rpcExec queue');
        self.rpcExecQueue.push({
            topic: topic,
            data: d,
            opts: opts,
            cb: cb
        });
        
        return;
    }

    if ('function' === typeof opts) {
        // shift arguments
        cb = opts;
        opts = {};
    }
    
    // this will send the data down the topic and then open up a unique return queue
    
    var rpcQueue = self._rpcQueueName(topic);
    
    var unique = shortId.generate() + '_' + ((Math.round(new Date().getTime() / 1000) + '').substr(5));
    var returnQueueName = rpcQueue + '.return.' + unique;
    
    var now = new Date().getTime();
        
    // bind the response queue
    var processed = false;

    self.connection.createChannel(function(err, channel) {
        if(err) {
            self.emit('error', err);
            if(cb) cb(err);
            return;
        }

        channel.assertQueue(self._formatName(returnQueueName), {
            exclusive: true,
            expires: (self.opts.defaultRPCExpiry*1 + 1000)
        });
        
        debug('rabbitr'.cyan, 'using rpc return queue', returnQueueName);

        var cleanup = function() {
            // delete the return queue and close exc channel
            try {
                channel.deleteQueue(self._formatName(returnQueueName), function() {
                    channel.close();
                });
            }
            catch(e) {
                console.log('rabbitr cleanup exception', e);
            }
        };

        // set a timeout
        var timeoutMS = (opts.timeout || self.opts.defaultRPCExpiry || kDefaultRPCExpiry) * 1;
        var timeout = setTimeout(function() {
            debug('request timeout firing for', rpcQueue, 'to', returnQueueName);    

            cb({
                message: 'Request timed out'
            });
            
            cleanup();
        }, timeoutMS);

        var processMessage = function processMessage(msg) {
            if(!msg) return;

            var data = msg.content.toString();
            if(msg.properties.contentType == 'application/json') {
                data = JSON.parse(data);
            }

            if(processed) {
                cleanup();
                return; 
            }
            processed = true;
            
            clearTimeout(timeout);

            var error = data.error;
            var response = data.response;

            if(error) {
                cb(error);
            }
            else {
                cb(null, response);
            }
            
            cleanup();
        };
        channel.consume(self._formatName(returnQueueName), processMessage, {
            noAck: true
        }, function(err) {
            if(err) {
                self.emit('error', err);
                if(cb) cb(err);
                return;
            }

            // send the request now
            var data = {
                d: d,
                returnQueue: self._formatName(returnQueueName),
                expiration: now+timeoutMS
            };
            self._publishChannel.sendToQueue(self._formatName(rpcQueue), new Buffer(JSON.stringify(data)), {
                contentType: 'application/json',
                expiration: timeoutMS
            });
        });
    });
};

Rabbitr.prototype.rpcListener = function rpcListener(topic, opts, executor, alreadyInQueue) {
    var self = this;
    
    if(alreadyInQueue != true) {
        debug('adding item to rpcListener queue');
        self.rpcListenerQueue.push({
            topic: topic,
            executor: executor,
            opts: opts
        });
    }
    
    if ('function' === typeof opts) {
        // shift arguments
        alreadyInQueue = executor;
        executor = opts;
        opts = {};
    }

    if(!self.ready) {
        return;
    }
    
    var rpcQueue = self._rpcQueueName(topic);  

    opts.skipMiddleware = true;
    self.subscribe(rpcQueue, opts, function() { });
    
    debug('has rpcListener for', topic);
    
    self.on(rpcQueue, function(message) {
        var dataEnvelope = message.data;
        message.data = dataEnvelope.d;
        
        var now = new Date().getTime();
        
        if(now > dataEnvelope.expiration) {
            message.ack();
            
            return;
        }

        // support for older clients - is this needed?
        message.queue = {
            shift: message.ack
        };

        self._runMiddleware(message, function(middlewareErr) {
            // TODO - how to handle common error function thing for middleware?

            executor(message, function(err, response) {
                if(err) {
                    debug('rpcListener'.cyan, 'hit error'.red, err);
                }

                // ack here - this will get ignored if the executor has acked or nacked already anyway
                message.ack();
                
                // doesn't need wrapping in self.formatName as the rpcExec function already formats the return queue name as required
                self._publishChannel.sendToQueue(dataEnvelope.returnQueue, new Buffer(JSON.stringify({
                    error: err ? JSON.stringify(err, Object.keys(err)) : undefined,
                    response: response,
                })), {
                    contentType: 'application/json'
                });
            });
        });
    });
};

// message middleware support
Rabbitr.prototype.use = function use(middlewareFunc) {
    var self = this;
    
    self.middleware.push(middlewareFunc);
};
Rabbitr.prototype._runMiddleware = function _runMiddleware(message, next) {
    var self = this;

    if(self.middleware.length === 0) return next();

    async.eachSeries(self.middleware, function(middlewareFunc, next) {
        middlewareFunc(message, next);
    }, next);
};
