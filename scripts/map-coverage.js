var lcovSourcemap = require('lcov-sourcemap');

lcovSourcemap.writeLcov('./coverage/lcov.info', {
  index: './index.js.map',
}, '.', './coverage/lcov-mapped.info').then(function () {
  console.log('Coverage Mapped!');
});
