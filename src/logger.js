/**
 * Logger simple con timestamp y niveles
 * Salida a consola (Railway captura stdout/stderr)
 */

const config = require('./config');
const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[config.LOG_LEVEL] ?? 1;

class Logger {
  constructor(prefix) {
    this.prefix = prefix;
  }

  _log(level, ...args) {
    if (LEVELS[level] < currentLevel) return;
    const ts = new Date().toISOString();
    const msg = `[${ts}] [${level.toUpperCase()}] [${this.prefix}] ${args.join(' ')}`;

    if (level === 'error') {
      console.error(msg);
    } else {
      console.log(msg);
    }

    // Escribir a archivo si está configurado
    if (config.LOG_FILE) {
      try {
        const dir = path.dirname(config.LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(config.LOG_FILE, msg + '\n');
      } catch (e) {
        // ignorar errores de escritura en log file
      }
    }
  }

  debug(...args) { this._log('debug', ...args); }
  info(...args)  { this._log('info',  ...args); }
  warn(...args)  { this._log('warn',  ...args); }
  error(...args) { this._log('error', ...args); }
}

module.exports = { Logger };
