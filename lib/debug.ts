export const log = require('debug')('rabbitr');

export function initWhitelist(): string[] | null {
  const {RABBITR_DEBUG} = process.env;
  if (RABBITR_DEBUG) {
    const channelsWhitelist = RABBITR_DEBUG.split(',');
    console.warn(
      '[warning] Rabbitr is running in debug mode. It will only subscribe to ' +
      'the following channels:\n' + channelsWhitelist.join('\n')
    );
    return channelsWhitelist;
  }
  return null;
}

export function shouldSkipSubscribe(whitelist: string[] | null, topic: string): boolean {
  if (!whitelist) return false;

  if ((whitelist as string[]).indexOf(topic) === -1) {
    return true;
  }

  return false;
}
