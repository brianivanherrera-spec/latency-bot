/**
 * Escritura atómica de archivos de estado (positions.json, signals.jsonl, stats.json).
 *
 * Antes se reescribían con fs.writeFileSync directo: un corte a mitad (redeploy, OOM)
 * dejaba el archivo truncado y al arrancar se perdía el historial o las posiciones
 * abiertas. Ahora: escribir a <archivo>.tmp, fsync, rename (atómico en el mismo
 * filesystem). Si falla, se loguea y se alerta por Discord (como mucho una vez cada
 * 30 min por archivo) en vez de tragarse el error.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Logger } = require('./logger');
const logger = new Logger('PERSIST');

const _lastAlert = new Map();

function writeFileAtomicSync(file, data) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// Escribe y nunca lanza: devuelve true/false. Loguea y alerta si falla.
function safeWriteAtomic(file, data, label = path.basename(file)) {
  try {
    writeFileAtomicSync(file, data);
    return true;
  } catch (e) {
    logger.error(`[PERSIST] ❌ No se pudo guardar ${label}: ${e.message}`);
    const now = Date.now();
    if (now - (_lastAlert.get(file) || 0) > 30 * 60 * 1000) {
      _lastAlert.set(file, now);
      try { require('./alerts').alertOperational('Falla al guardar estado', `${label}: ${e.message}`); } catch (_) {}
    }
    return false;
  }
}

module.exports = { writeFileAtomicSync, safeWriteAtomic };
