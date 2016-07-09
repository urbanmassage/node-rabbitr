export const log = require('debug')('rabbitr');

export function initWhitelist(): string[] | void {
  const {RABBITR_DEBUG} = process.env;
  if (RABBITR_DEBUG) {
    const channelsWhitelist = RABBITR_DEBUG.split(',');
    console.warn('[warning] Rabbitr is running in debug mode. Only the following channels will be subscribed to:', channelsWhitelist.join('\n'));
    return channelsWhitelist;
  }
  return null;
}

export function shouldSkipSubscribe(whitelist: string[] | void, topic: string): boolean {
  if (!whitelist) return false;

  if ((whitelist as string[]).indexOf(topic) === -1) {
    return true;
  }

  return false;
}
