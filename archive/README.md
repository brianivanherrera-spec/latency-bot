# Archivo

Código y documentos que el bot ya no usa (revisión del 02/10/2026, bloque E6). Se movieron
acá en vez de borrarse. Ninguno es requerido por `src/index-final.js` ni por `scripts/`
(verificado con el grafo de `require`). Los módulos de `archive/src/` que hacen
`require('./logger')` u otros relativos ya no corren tal cual desde esta carpeta.

- `src/analyze-lag-metrics.js`, `diagnostics-integration.js`, `event-diagnostics.js`,
  `monitoring.js`, `strike-validator.js`, `validate-phase2*.js`: herramientas viejas sin uso.
- `src/polymarket-user-ws.js`: WebSocket de usuario con protocolo incorrecto (bloque D10).
- `src/test-book-filter*.js`: pruebas del filtro de libro (siguen corriendo con
  `node archive/src/test-book-filter-assertions.js`; 3 de 11 fallan desde antes).
- `docs/`: documentos de análisis y planes viejos que estaban en la raíz.
