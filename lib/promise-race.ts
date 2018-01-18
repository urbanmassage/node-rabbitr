export function racePromises<T>(...promises: Promise<T>[]): Promise<T> {
  let hasResolved = false;
  return new Promise<T>((resolve: (result: T) => void, reject) => {
    for(const promiseItem of promises) {
      promiseItem.then(
        (result: T) => {
          // prevent double firing
          if(hasResolved) return;
          hasResolved = true;

          // resolve the main promise
          resolve(result);
        },
        (err) => {
          // prevent double firing
          if(hasResolved) return;
          hasResolved = true;

          // reject the main promise
          reject(err);
        }
      );
    }
  });
}
