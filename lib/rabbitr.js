var util = require('util');
var EventEmitter = require('events').EventEmitter;
var colors = require('colors');
var amqp = require('amqp');
var shortId = require('shortid');
var debug = require('debug')('rabbitr');

var kDefaultRPCExpiry = 15000; // 15 seconds

var Rabbitr = module.exports = function constructor(opts) {
    EventEmitter.call( this );
    
    // set 'url' to override host, login, password params for node-amqp connection
    var o = this.opts = {
        queuePrefix: '', // preffixed to all queue names - useful for environment and app names etc
        host: 'localhost', // rabbitmq host
        login: 'guest', // rabbitmq user
        password: 'guest', // rabbitmq pass
        setup: function(done) { done(); }, // called once the connection is ready but before anything is bound (allows for ORM setup etc)
        queueOpts: { // these must be valid queue options for node-amqp
            durable: true,
            autoDelete: false
        },
        exchangeOpts: {
    		durable: true,
    		autoDelete: false
    	},
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
    this.rpcListenerQueue = [];
    this.rpcExecQueue = [];
    this.setTimerQueue = [];
    this.clearTimerQueue = [];
    this.subscribes = {}; // used to make sure we don't double subscribe to the same queue
    this.rpcSubscribes = {}; // used to make sure we don't double subscribe to the same rpc queue
    this.rpcBindings = {}; // used to make sure we don't double bind
    
    var self = this;
    
    // stored as a locally scoped var rather than as a prototype as we don't really want 
    var connect = function() {
    	debug('rabbitr'.cyan, '#connect');
    	
    	var connectionObj;
    	if(typeof(self.opts.url) === 'string') {
    		connectionObj = { 
		    	url: self.opts.url
		    };
    	}
    	else {
    		connectionObj = { 
		    	host: self.opts.host,
		    	login: self.opts.login,
		    	password: self.opts.password 
		    };
    	}

    	debug('rabbitr'.cyan, 'using connection options', connectionObj);

	    self.connection = amqp.createConnection(connectionObj);
    
	    self.connection.on('ready', function () {		    	
	    	if(self.connected) return;
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
	    
	    self.connection.socket.on('close', function(e) {
	    	self.ready = false;
	    	self.connected = false;
	    	self.connection.reconnect();
	    });
    };
    
    // create the connection on init
    connect();
    
    return this;
};
util.inherits(Rabbitr, EventEmitter);

Rabbitr.prototype.formatName = function(name) {
	var self = this;

    if(self.opts.queuePrefix != '') {
        name = self.opts.queuePrefix + '.' + name;
    }
    
    return name;
};

// standard pub/sub stuff
Rabbitr.prototype.send = function(topic, data, cb, opts) {
	var self = this;
	
	if(!self.ready) {
		debug('rabbitr'.cyan, 'adding item to send queue');
		return self.sendQueue.push({
		    topic: topic,
		    data: data,
		    cb: cb,
		    opts: opts
		});
	}
	
	if(!opts) opts = {};
	
	debug('rabbitr.send'.yellow, topic, data, opts);
	
	var exc = self.connection.exchange(self.formatName(topic), opts.exchangeOpts || self.opts.exchangeOpts, function (exchange) {
		debug('rabbitr'.cyan, 'exchange ' + topic + ' is open');
		exchange.publish(opts.routingKey || '', data, opts.messageOpts || {}, function() {
			debug('rabbitr'.cyan, 'sent message'.cyan, topic, data);
			
		});
		
		if(cb) {
			return cb(null);
		}
	});
};
Rabbitr.prototype.subscribe = function(topic, opts, cb, alreadyInQueue) {
    var self = this;
    
    if(!cb) {
	    cb = opts;
	    opts = null;
    }

	if(self.subscribes[topic]) return;
	
	if(alreadyInQueue != true) {
		debug('rabbitr'.cyan, 'adding item to sub queue');
		self.subscribeQueue.push({
		    topic: topic,
		    opts: opts,
		    cb: cb
		});
	}
	
	if(!self.ready) {
		return;
	}
	
	debug('rabbitr.subscribe'.cyan, topic, opts);
	
	self.subscribes[topic] = self.connection.queue(self.formatName(topic), self.opts.queueOpts, function (queue) {
		debug('rabbitr'.cyan, 'queue ' + topic + ' is open');
		
		queue.subscribe(opts || { ack: true }, function (message, headers, deliveryInfo, messageObject) {			
			debug('rabbitr'.cyan, 'got', topic, message);
		
            var acked = false;

			self.emit(topic, {
				data: message,
				queue: queue,
				ack: function() {
					debug('rabbitr'.cyan, 'acknowledging message', topic, message);
					
                    if(acked) return;
                    acked = true;

					// this does nothing for now as we don't actually ack messages, means we can in the future though
					
					//messageObject.acknowledge();
					queue.shift();
				}
			}); 
		});
		
		if(cb) {
			return cb(null, queue);
		}
	});
};
Rabbitr.prototype.bindExchangeToQueue = function(exchange, queue, cb, alreadyInQueue) {
    var self = this;

	if(alreadyInQueue != true) {
		debug('rabbitr'.cyan, 'adding item to bindings queue');
		self.bindingsQueue.push({
			exchange: exchange,
			queue: queue,
			cb: cb
		});
	}

	if(!self.ready) {
		return;
	}
	
	debug('rabbitr.bindExchangeToQueue'.cyan, exchange, queue);
	
	self.connection.queue(self.formatName(queue), self.opts.queueOpts, function (q) {
		self.connection.exchange(self.formatName(exchange), self.opts.exchangeOpts, function (exc) {
			q.bind(exc, '#', function() {
				debug('rabbitr'.cyan, 'bound', exchange, 'to', queue);		
				
				if(cb) cb(null, exc, q);
			});
		});
	});
};

// timed queue stuff
Rabbitr.prototype.timerQueueName = function(topic, uniqueID) {
    return 'dlq.' + topic + '.' + uniqueID;
};
Rabbitr.prototype.setTimer = function(topic, uniqueID, data, ttl, cb) {
    var self = this;
    
    if(!self.ready) {
		debug('rabbitr'.cyan, 'adding item to setTimer queue');
		self.setTimerQueue.push({
			topic: topic,
			uniqueID: uniqueID,
			data: data,
			ttl: ttl,
			cb: cb
		});
		
		return;
	}

    var timerQueue = self.timerQueueName(topic, uniqueID);
    
    debug('rabbitr.setTimer'.yellow, topic, uniqueID);
    
    self.connection.queue(self.formatName(timerQueue), {
        arguments: {
          "x-dead-letter-exchange": self.formatName(topic), 
          "x-message-ttl": ttl, 
          "x-expires": (ttl + 1000)
        }
    }, function (dlq) {
        self.connection.publish(self.formatName(timerQueue), data);
    
        debug('rabbitr.publish'.yellow, timerQueue, data);
    
        if(cb) {
            return cb(null);
        }
    });
};
Rabbitr.prototype.clearTimer = function(topic, uniqueID, cb) {
    var self = this;
    
    if(!self.ready) {
		debug('rabbitr'.cyan, 'adding item to clearTimer queue');
		self.clearTimerQueue.push({
			topic: topic,
			uniqueID: uniqueID,
			cb: cb
		});
		
		return;
	}
    
    var timerQueue = self.timerQueueName(topic, uniqueID);
    
    self.connection.queue(self.formatName(timerQueue), {
        noDeclare: true
    }, function (dlq) {
        dlq.destroy();
    
        if(cb) {
            return cb(null);
        }
    });
};


// rpc stuff
Rabbitr.prototype.rpcQueueName = function(topic) {
    return 'rpc.' + topic;
};
Rabbitr.prototype.rpcExec = function(topic, d, cb) {
    var self = this;
    
	if(!self.ready) {
		debug('rabbitr'.cyan, 'adding item to rpcExec queue');
		self.rpcExecQueue.push({
			topic: topic,
			data: d,
			cb: cb
		});
		
		return;
	}
    
    // this will send the data down the topic and then open up a unique return queue
    
    var rpcQueue = self.rpcQueueName(topic);
    
    var unique = shortId.generate() + '_' + ((Math.round(new Date().getTime() / 1000) + '').substr(5));
    var returnQueueName = rpcQueue + '.return.' + unique;
    var returnExchangeName = rpcQueue + '.return';    
    
	var responseQueueOpts = {
	    ack: true,
        arguments: {
    	    "x-message-ttl": self.opts.defaultRPCExpiry,
    	    'x-expires': self.opts.defaultRPCExpiry
        }
    };
    
    var now = new Date().getTime();
        
    // bind the response queue
    var processed = false;
    self.rpcSubscribes[returnQueueName] = self.connection.queue(self.formatName(returnQueueName), responseQueueOpts, function (queue) {
		debug('rabbitr'.cyan, 'rpc queue ' + rpcQueue + ' is open');
		
		// bind 
		self.connection.exchange(self.formatName(returnExchangeName), self.opts.exchangeOpts, function (exc) {
			queue.bind(exc, unique, function() {
				debug('rabbitr'.cyan, 'bound rpc', rpcQueue, 'to', returnQueueName);	
				
                var cleanup = function() {
                    // delete the return exc and queue
                    try {
                        queue.unbind(exc, unique);
                        queue.destroy();
                    }
                    catch(e) {
                        console.log('rabbitr cleanup exception', e);
                    }
                };

				// set a timeout
			    var timeout = setTimeout(function() {
                    debug('rabbitr'.cyan, 'request timeout firing for', rpcQueue, 'to', returnQueueName);    

			        cb({
			            message: 'Request timed out'
			        });
			        
			        cleanup();
			    }, self.opts.defaultRPCExpiry);
				
				// listen for messages on the response queue
				queue.subscribe(responseQueueOpts, function (message, headers, deliveryInfo, messageObject) {
                    if(processed) {
                    	//console.log('double response to rpc q');
                        cleanup();
                    	return;	
                    }
                    processed = true;
                    
                    clearTimeout(timeout);
                
        	        cb(null, {
        	            data: message,
        	            ack: function() {}
        	        });
        	        
        	        cleanup();
                });
                
                // send the request now
    		    var data = {
    		        d: d,
    		        returnExchange: returnExchangeName,
    		        returnRoutingKey: unique,
    		        expiration: now+(self.opts.defaultRPCExpiry*1)
    		    };
    		    self.send(rpcQueue, data, function() {}, {
	                
    		    });
			});
		});
    });
};

Rabbitr.prototype.rpcListener = function(topic, executor, alreadyInQueue) {
    var self = this;
    
    if(alreadyInQueue != true) {
		debug('rabbitr'.cyan, 'adding item to rpcListener queue');
		self.rpcListenerQueue.push({
			topic: topic,
			executor: executor
		});
	}

	if(!self.ready) {
		return;
	}
    
    var rpcQueue = self.rpcQueueName(topic);  
	
    self.subscribe(rpcQueue, {
	    ack: true,
	    autoDelete: false
    }, function() { 
        self.bindExchangeToQueue(rpcQueue, rpcQueue, function() {
            
        });
        
        debug('rabbitr'.cyan, 'has rpcListener for', topic);
        
        self.on(rpcQueue, function(message) {
            var data = message.data.d;
            
            var now = new Date().getTime();
            
            if(now > message.data.expiration) {
	            message.queue.shift();
	            
	            return;
            }
                        
            executor({
            	data: data,
            	queue: message.queue
            }, function(err, response) {
                if(err) {
                    return debug('rabbitr.rpcListener'.cyan, 'hit error'.red, err);
                }
                
                // doesn't need wrapping in self.formatName as the rpcExec function already formats the return queue name as required
                self.send(message.data.returnExchange, response, function() {}, {
	                routingKey: message.data.returnRoutingKey
                });
            });
        });
    }); /* */
};