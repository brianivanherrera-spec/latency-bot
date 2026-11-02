# Segunda capa (con precios) — version v1 (CONGELADO)

Alimenta la estrategia C (solo paper). La capa ciega (research-v1) NO cambia: el pronostico del dia se escribe y se sube ANTES de mirar cualquier precio.

Cuando correr: despues de que el bot compro (las compras del dia aparecen como `PAPER compra` y `POSICION` en el log del servicio). Las confirmaciones aplican solo a compras del mismo dia UTC.

Por cada compra paper del dia (`PAPER compra <lado> <market_id>`):
1. Lee las reglas COMPLETAS del mercado (la linea `CANDIDATO <fecha>` del log), la fecha y la fuente de resolucion. Si la definicion es ambigua (por ejemplo "Pro", "primero", "al cierre"), anotalo.
2. Mira el precio de entrada (`POSICION ... precio_medio`) y el precio actual (`VALOR`, si existe). Compara con tu p_yes del dia: si la divergencia es grande, preguntate que sabe el mercado que vos no.
3. Revisa el tiempo que falta para resolver. Si faltan mas de 5 dias, el precio esta por debajo de 0,30 y no hay una razon concreta (catalizador con fecha), preferi descartar o reducir.
4. Decide una accion:
   - `confirmar`: la apuesta se mantiene entera.
   - `reducir`: se mantiene al monto indicado en `factor` (0 < factor < 1, por defecto 0,5).
   - `descartar`: no entra en C.
5. Maximo 2 busquedas web por compra, solo si hace falta (bloqueados polymarket.com, kalshi.com, manifold.markets, metaculus.com, predictit.org; ignorar cuotas). Las fuentes siguen la politica de revision-v1.

Salida: forecaster/confirmaciones/AAAA-MM-DD.json, un arreglo:
{ "market_id": "...", "side": "SI|NO", "accion": "confirmar|reducir|descartar", "factor": 0.5, "precio_visto": 0.00, "motivo": "corto (max 2 frases)" }

Reglas:
- Una entrada por compra; las compras sin entrada quedan fuera de C ("sin_revisar").
- Esta capa NO cambia pronosticos registrados, compras de A ni la estrategia B.
- Todo lo de C se evalua aparte: el pronostico v1 sigue siendo la linea base ciega.
- Commit y push a claude/forecaster; no tocar otra rama.
