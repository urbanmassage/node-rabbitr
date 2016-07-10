// istanbul ignore next
if (parseFloat(process.version.match(/^v(\d+\.\d+)/)[1]) < 0.4) {
  // Monkey-patch :(
  // https://github.com/nodejs/node-v0.x-archive/issues/5110
  Buffer.prototype.toJSON = function() {
    return { type: 'Buffer', data: Array.prototype.slice.call(this, 0) };
  };
}

export function stringify(obj: any): string {
  return JSON.stringify(obj);
}

// helper function to properly stringify an error object
export function stringifyError(err, filter?, space?) {
  var plainObject = {
    stack: err.stack,
  };
  Object.getOwnPropertyNames(err).forEach(function(key) {
    plainObject[key] = err[key];
  });
  return JSON.stringify(plainObject, filter, space);
}

export function parse(json: string): any {
  return JSON.parse(json, function(key, value) {
    return value && value.type === 'Buffer'
      ? new Buffer(value.data)
      : value;
  });
}

export function parseError(json: string): any {
  let error = parse(json);
  let err: any = new Error(error.message);
  Object.keys(error).forEach(function(key) {
    if (err[key] !== error[key]) {
      err[key] = error[key];
    }
  });
  return err;
}
