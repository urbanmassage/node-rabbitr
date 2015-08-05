var util = require('util');
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
        defaultRPCExpiry: 60000
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
                        self.rpcListener(self.rpcListenerQueue[i].topic, self.rpcListenerQueue[i].executor, true);
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
                        self.rpcExec(self.rpcExecQueue[i].topic, self.rpcExecQueue[i].data, self.rpcExecQueue[i].cb);
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

    self._publishChannel.assertExchange(self._formatName(topic), 'topic');

    self._publishChannel.publish(self._formatName(topic), '*', new Buffer(JSON.stringify(data)), {
        contentType: 'application/json'
    });

    if(cb) cb(null);
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
            channel.prefetch(1);

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

                self.emit(topic, {
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
Rabbitr.prototype.rpcExec = function rpcExec(topic, d, cb) {
    var self = this;
    
    if(!self.ready) {
        debug('adding item to rpcExec queue');
        self.rpcExecQueue.push({
            topic: topic,
            data: d,
            cb: cb
        });
        
        return;
    }
    
    // this will send the data down the topic and then open up a unique return queue
    
    var rpcQueue = self._rpcQueueName(topic);
    
    var unique = shortId.generate() + '_' + ((Math.round(new Date().getTime() / 1000) + '').substr(5));
    var returnRoutingKey = unique;
    var returnQueueName = rpcQueue + '.return.' + unique;
    var returnExchangeName = rpcQueue + '.return';
    
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
            expires: (self.opts.defaultRPCExpiry*1 + 1000)
        });
        channel.assertExchange(self._formatName(returnExchangeName), 'topic');
        channel.assertExchange(self._formatName(rpcQueue), 'topic');
             
        channel.bindQueue(self._formatName(returnQueueName), self._formatName(returnExchangeName), returnRoutingKey, {}, function(err) {
            if(err) {
                self.emit('error', err);
                if(cb) cb(err);
                return;
            }

            debug('rabbitr'.cyan, 'bound rpc', returnExchangeName, 'to', returnQueueName);    
        
            var cleanup = function() {
                // delete the return exc and close exc channel
                try {
                    channel.unbindQueue(self._formatName(returnQueueName), self._formatName(returnExchangeName), returnRoutingKey, {}, function(err) {
                        channel.deleteQueue(self._formatName(returnQueueName), function() {
                            channel.close();
                        });
                    });
                }
                catch(e) {
                    console.log('rabbitr cleanup exception', e);
                }
            };

            // set a timeout
            var timeout = setTimeout(function() {
                debug('request timeout firing for', rpcQueue, 'to', returnQueueName);    

                cb({
                    message: 'Request timed out'
                });
                
                cleanup();
            }, self.opts.defaultRPCExpiry);

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
            
                cb(null, {
                    data: data,
                    ack: function() {}, // no-op as this queue is in noAck mode
                    reject: function() {} // no-op as this queue is in noAck mode
                });
                
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
                    returnExchange: self._formatName(returnExchangeName),
                    returnRoutingKey: returnRoutingKey,
                    expiration: now+(self.opts.defaultRPCExpiry*1)
                };
                self._publishChannel.publish(self._formatName(rpcQueue), '*', new Buffer(JSON.stringify(data)), {
                    contentType: 'application/json',
                    expiration: self.opts.defaultRPCExpiry*1
                });
            });
        });
    });
};

Rabbitr.prototype.rpcListener = function rpcListener(topic, executor, alreadyInQueue) {
    var self = this;
    
    if(alreadyInQueue != true) {
        debug('adding item to rpcListener queue');
        self.rpcListenerQueue.push({
            topic: topic,
            executor: executor
        });
    }

    if(!self.ready) {
        return;
    }
    
    var rpcQueue = self._rpcQueueName(topic);  

    self.subscribe(rpcQueue, function() { });
    self.bindExchangeToQueue(rpcQueue, rpcQueue, function() { });
    
    debug('has rpcListener for', topic);
    
    self.on(rpcQueue, function(message) {
        var data = message.data.d;
        
        var now = new Date().getTime();
        
        if(now > message.data.expiration) {
            message.ack();
            
            return;
        }
                    
        executor({
            data: data,
            queue: {
                shift: message.ack
            },
            ack: message.ack,
            reject: message.reject
        }, function(err, response) {
            if(err) {
                return debug('rpcListener'.cyan, 'hit error'.red, err);
            }
            
            // doesn't need wrapping in self.formatName as the rpcExec function already formats the return queue name as required
            self._publishChannel.publish(message.data.returnExchange, message.data.returnRoutingKey, new Buffer(JSON.stringify(response)), {
                contentType: 'application/json'
            });
        });
    });
};
