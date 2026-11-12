# Segunda capa (con precios) — version v3 (CONGELADO desde 2026-11-13)

Reemplaza a confirmacion-v2 desde el 2026-11-13. Cambio principal: C parte del filtro de B y la revision con precios solo puede reducir o descartar.

Alimenta la estrategia C (solo paper). La capa ciega (research-v3) NO cambia: el pronostico del dia se escribe y se sube ANTES de mirar cualquier precio.

Cuando correr: despues de que el bot compro (lineas `PAPER compra` y `POSICION` del dia UTC).

Por cada compra paper del dia (`PAPER compra <lado> <market_id>`):
1. Filtro B (obligatorio, sin excepciones). Si falla cualquiera, `descartar` con motivo "filtro B":
   - precio de entrada (`POSICION ... precio_medio`) >= 0,30;
   - |p del lado comprado − precio de entrada| <= 0,15 (p del lado = p_yes del pronostico del dia si se compro SI, 1 − p_yes si se compro NO);
   - una sola posicion por mercado y por evento en C: si C ya tiene ese mercado o evento abierto, descartar ("duplicada").
2. Si pasa el filtro, revisar reglas completas (linea `CANDIDATO`), fecha y fuente de resolucion. Si hay ambiguedad que pueda dar vuelta el resultado, `reducir`.
3. Regla de tiempo: si faltan mas de 10 dias y el precio de entrada esta fuera de 0,30–0,70, como maximo `reducir` (factor 0,5).
4. Tecnologia y economia: si la divergencia (paso 1) es mayor a 0,10, `reducir` salvo razon verificada.
5. Acciones posibles: `confirmar` (pasa todo), `reducir` (factor 0,5 por defecto) o `descartar`. La revision con precios nunca agranda una apuesta ni rescata una compra que no pasa el filtro B.
6. Maximo 1 busqueda web por compra y solo si la divergencia es mayor a 0,10 (bloqueados polymarket.com, kalshi.com, manifold.markets, metaculus.com, predictit.org; ignorar cuotas).

Salida: forecaster/confirmaciones/AAAA-MM-DD.json, un arreglo:
{ "market_id": "...", "side": "SI|NO", "accion": "confirmar|reducir|descartar", "factor": 0.5, "precio_visto": 0.00, "categoria": "tecnologia|economia|politica|mundo|otro", "version": "v3", "motivo": "corto (max 2 frases)" }

Reglas:
- Una entrada por compra; las compras sin entrada quedan fuera de C ("sin_revisar").
- Esta capa NO cambia pronosticos registrados, compras de A ni la estrategia B.
- Commit y push a claude/forecaster; no tocar otra rama.
