node-rabbitr
============

Init / setup
---------------

    var rabbit = new Rabbitr(opts);

Basic queue usage
-----------------


    rabbit.subscribe('specific.queue.name');
    rabbit.bindExchangeToQueue('exchange.name', 'specific.queue.name');
    rabbit.on('specific.queue.name', function(message) {
      // do something
  
      message.ack();
    });
