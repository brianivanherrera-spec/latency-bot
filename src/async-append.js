/**
 * Escritura a archivos en segundo plano (buffer + flush cada 500 ms).
 *
 * Antes cada evento del WS de Polymarket / cada tick / cada línea de log hacía
 * fs.appendFileSync (+ existsSync/statSync), bloqueando el event loop. Con el
 * tráfico del horario de EE. UU. el socket de Polymarket no se leía a tiempo y el
 * servidor cortaba con 1013 "slow consumer". Acá las líneas se acumulan en memoria
 * y se escriben de a bloques con fs.promises.appendFile, sin bloquear.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FLUSH_MS = 500;
const MAX_LINES = 50000;       // tope por archivo si el disco se atrasa (se descartan las más viejas)
const ROTATE_CHECK_MS = 30000; // chequeo de tamaño para rotar, como mucho cada 30 s

const bufs = new Map(); // file -> { lines, writing, maxBytes, checkedAt }
let timer = null;

function rotatedName(file) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const ext = path.extname(file);
  return path.join(path.dirname(file), `${path.basename(file, ext)}.${ts}${ext}`);
}

/**
 * Agrega una línea (sin '\n') al archivo. maxBytes > 0 rota el archivo cuando lo supera.
 */
function append(file, line, { maxBytes = 0 } = {}) {
  let b = bufs.get(file);
  if (!b) {
    b = { lines: [], writing: false, maxBytes, checkedAt: 0 };
    bufs.set(file, b);
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}
  }
  b.lines.push(line);
  if (b.lines.length > MAX_LINES) b.lines.splice(0, b.lines.length - MAX_LINES);
  if (!timer) {
    timer = setInterval(flushAll, FLUSH_MS);
    if (timer.unref) timer.unref();
  }
}

async function flushOne(file, b) {
  if (b.writing || !b.lines.length) return;
  b.writing = true;
  const chunk = b.lines.join('\n') + '\n';
  b.lines = [];
  try {
    if (b.maxBytes && Date.now() - b.checkedAt > ROTATE_CHECK_MS) {
      b.checkedAt = Date.now();
      const st = await fs.promises.stat(file).catch(() => null);
      if (st && st.size > b.maxBytes) await fs.promises.rename(file, rotatedName(file)).catch(() => {});
    }
    await fs.promises.appendFile(file, chunk);
  } catch (_) {
    // disco lleno / volumen caído: se pierde este bloque, el bot sigue
  } finally {
    b.writing = false;
  }
}

function flushAll() {
  for (const [file, b] of bufs) flushOne(file, b);
}

// Al salir (redeploy = SIGTERM → process.exit), escribir lo que quede pendiente
function flushSync() {
  for (const [file, b] of bufs) {
    if (!b.lines.length) continue;
    try { fs.appendFileSync(file, b.lines.join('\n') + '\n'); } catch (_) {}
    b.lines = [];
  }
}
process.on('exit', flushSync);

module.exports = { append, flushSync };
