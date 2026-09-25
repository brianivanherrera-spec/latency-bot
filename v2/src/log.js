'use strict';
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN = LEVELS[process.env.V2_LOG_LEVEL || 'info'] ?? 1;
function make(tag) {
  const out = (lvl, msg) => {
    if (LEVELS[lvl] < MIN) return;
    const line = `[${new Date().toISOString()}] [${lvl.toUpperCase()}] [V2:${tag}] ${msg}`;
    (lvl === 'error' ? console.error : console.log)(line);
  };
  return { debug: m => out('debug', m), info: m => out('info', m), warn: m => out('warn', m), error: m => out('error', m) };
}
module.exports = { make };
