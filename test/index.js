// this file will load all the tests and run them

var commander = require('commander');

global.opts = {
    host: process.argv[2]
};

if(process.argv[3]) {
    opts.port = process.argv[3];
};

console.log(opts);

