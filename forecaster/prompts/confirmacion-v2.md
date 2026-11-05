# Segunda capa (con precios) — version v2 (CONGELADO desde 2026-11-06)

Reemplaza a confirmacion-v1 desde el 2026-11-06. Cambios: umbral mas estricto en tecnologia y economia, regla de tiempo, y busqueda para entender al mercado cuando la divergencia es grande. Lo demas es igual.

Alimenta la estrategia C (solo paper). La capa ciega (research-v2) NO cambia: el pronostico del dia se escribe y se sube ANTES de mirar cualquier precio.

Cuando correr: despues de que el bot compro (las compras del dia aparecen como `PAPER compra` y `POSICION` en el log del servicio). Las confirmaciones aplican solo a compras del mismo dia UTC.

Por cada compra paper del dia (`PAPER compra <lado> <market_id>`):
1. Lee las reglas COMPLETAS del mercado (la linea `CANDIDATO <fecha>` del log), la fecha y la fuente de resolucion. Si la definicion es ambigua (por ejemplo "Pro", "primero", "al cierre"), anotalo.
2. Mira el precio de entrada (`POSICION ... precio_medio`) y el precio actual (`VALOR`, si existe). Calcula la divergencia = |p del lado comprado − precio de entrada|.
3. Si la divergencia es mayor a 0,15: hace 1 o 2 busquedas para entender que sabe el mercado (noticia reciente, dato nuevo, lectura distinta de la regla). Anota lo que encontraste en `motivo`, aunque descartes.
4. Reglas por categoria:
   - Tecnologia y economia (lanzamientos, rankings, capitalizacion, datos macro, bancos centrales, precios): si la divergencia es mayor a 0,10, descartar salvo que haya una razon concreta y verificada que el mercado no refleje.
   - Resto (politica, mundo, deportes, etc.): se mantiene el criterio de v1.
5. Regla de tiempo: si faltan mas de 10 dias para resolver y el precio de entrada esta fuera de 0,30–0,70, como maximo `reducir` (factor 0,5). Si ademas faltan mas de 5 dias, el precio esta por debajo de 0,30 y no hay catalizador con fecha, preferi descartar (igual que v1).
6. Decide una accion:
   - `confirmar`: la apuesta se mantiene entera.
   - `reducir`: se mantiene al monto indicado en `factor` (0 < factor < 1, por defecto 0,5).
   - `descartar`: no entra en C.
7. Maximo 2 busquedas web por compra (bloqueados polymarket.com, kalshi.com, manifold.markets, metaculus.com, predictit.org; ignorar cuotas). Las fuentes siguen la politica de revision-v1.

Salida: forecaster/confirmaciones/AAAA-MM-DD.json, un arreglo:
{ "market_id": "...", "side": "SI|NO", "accion": "confirmar|reducir|descartar", "factor": 0.5, "precio_visto": 0.00, "categoria": "tecnologia|economia|politica|mundo|otro", "version": "v2", "motivo": "corto (max 2 frases)" }

Reglas:
- Una entrada por compra; las compras sin entrada quedan fuera de C ("sin_revisar").
- Esta capa NO cambia pronosticos registrados, compras de A ni la estrategia B.
- Todo lo de C se evalua aparte: el pronostico ciego sigue siendo la linea base.
- Commit y push a claude/forecaster; no tocar otra rama.
