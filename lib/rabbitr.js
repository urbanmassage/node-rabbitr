var util = require('util');
var EventEmitter = require('events').EventEmitter;
var colors = require('colors');
var amqp = require('amqp');
var shortId = require('shortid');
var debug = require('debug')('rabbitr')

var Rabbitr = module.exports = function constructor(opts) {
    EventEmitter.call( this );
    
    var o = this.opts = {
        queuePrefix: '', // preffixed to all queue names - useful for environment and app names etc
        host: 'localhost', // rabbitmq host
        setup: function(done) { done(); }, // called once the connection is ready but before anything is bound (allows for ORM setup etc)
        queueOpts: { // these must be valid queue options for node-amqp
            durable: true,
            autoDelete: false
        },
        exchangeOpts: {
    		durable: true,
    		autoDelete: false
    	}
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
    this.rpcBindings = {}; // used to make sure we don't double bind
    
    var self = this;
    
    // stored as a locally scoped var rather than as a prototype as we don't really want 
    var connect = function() {
    	debug('rabbitr'.cyan, '#setup');
    
	    self.connection = amqp.createConnection({ host: self.opts.host });
    
	    self.connection.on('ready', function () {	
	    	console.log('rabbitr'.cyan, 'amqp is ready');
	    	
	    	if(self.connected) return;
	    	self.connected = true;
	    	
	    	var afterSetup = function() {
		    	self.ready = true;
		    	
	    		debug('rabbitr'.cyan, 'is ready and has queue sizes', self.subscribeQueue.length, self.bindingsQueue.length, self.rpcListenersQueue.length, self.sendQueue.length, self.rpcExecQueue.length);
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
	
	debug('rabbitr.send'.yellow, topic, data);
	
	var exc = self.connection.exchange(self.formatName(topic), self.opts.exchangeOpts, function (exchange) {
		debug('rabbitr'.cyan, 'exchange ' + topic + ' is open');
		exchange.publish('', data, (opts || {}), function() {
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
		
		queue.subscribe(opts || { ack: false }, function (message, headers, deliveryInfo, messageObject) {			
			debug('rabbitr'.cyan, 'got', topic, message);
		
			self.emit(topic, {
				data: message,
				queue: queue,
				ack: function() {
					debug('rabbitr'.cyan, 'acknowledging message', topic, message);
					
					// this does nothing for now as we don't actually ack messages, means we can in the future though
					
					//messageObject.acknowledge();
					//queue.shift();
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
	
	self.connection.queue(self.formatName(queue), {
	    noDeclare: true
	}, function (q) {
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
var defaultRPCExpiry = 15000; // 15 seconds
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
        
    var timeout = setTimeout(function() {
        cb({
            message: 'Request timed out'
        });
    }, defaultRPCExpiry); // timeout after 
        
    // bind the response queue
    self.subscribe(returnQueueName, function() {
	    self.bindExchangeToQueue(returnQueueName, returnQueueName, function(err, queue, exchange) {
	        self.once(returnQueueName, function(message) {
	            clearTimeout(timeout);
	        
    	        cb(null, message);
    	        
    	        // delete the return exc and queue
    	        queue.destroy();
    	        exchange.destroy();
	        });    
	    
		    // send the request now
		    var data = {
		        d: d,
		        returnQueue: returnQueueName
		    };
		    self.send(rpcQueue, data, function() {}, {
    		    
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
	    autoDelete: false,
	    "x-message-ttl": defaultRPCExpiry
    }, function() { 
        self.bindExchangeToQueue(rpcQueue, rpcQueue, function() {
            
        });
        
        debug('rabbitr'.cyan, 'has rpcListener for', topic);
        
        self.on(rpcQueue, function(message) {
            var data = message.data.d;
            
            var returnQueueName = message.data.returnQueue;
            
            executor({
            	data: data,
            	queue: message.queue
            }, function(err, response) {
                if(err) {
                    return debug('rabbitr.rpcListener'.cyan, 'hit error'.red, err);
                }
                
                // doesn't need wrapping in self.formatName as the rpcExec function already formats the return queue name as required
                self.send(returnQueueName, response);
            });
        });
    });
};