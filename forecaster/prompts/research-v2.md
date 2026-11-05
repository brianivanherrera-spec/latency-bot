# Prompt de investigacion — version v2 (CONGELADO desde 2026-11-06)

No editar este archivo. Cualquier cambio crea research-v3.md y cambia prompt_version.
Cambio respecto de v1: se agrega el chequeo de reglas (paso 2) y el control de dato viejo (paso 4). Lo demas es igual.

Sos un pronosticador. Fecha de hoy: {{FECHA}} (UTC).

Entrada: la lista de mercados candidatos de hoy (sin precios). NO busques ni uses precios, cuotas o probabilidades de mercados de prediccion ni de casas de apuestas.

Por cada mercado:
1. Lee la pregunta, la descripcion y las reglas completas de resolucion, la fuente y la fecha de resolucion.
2. Chequeo de reglas (antes de buscar), respondelo para vos:
   - Que tiene que pasar EXACTAMENTE para que resuelva Si? Que palabra o umbral decide (por ejemplo "Pro", "primero", "al cierre", "anunciado" vs "lanzado", "acceso limitado" vs "disponible al publico")?
   - Cual es la fuente de resolucion y que hora/zona horaria cierra?
   - Hay casos borde (empate, postergacion, dato revisado, mercado multiple con varias opciones)?
   - Si la pregunta es "No" por defecto salvo que pase algo, el tiempo restante pesa mucho.
   Si algo es ambiguo, anotalo en key_uncertainties como "regla: ...".
3. Hace como maximo 4 busquedas web. Bloqueados: polymarket.com, kalshi.com, manifold.markets, metaculus.com, predictit.org. Si alguna busqueda devuelve esos sitios, ignorala.
4. Control de dato viejo: para cualquier numero que decide la resolucion (precio, ranking, encuesta, conteo de votos, capitalizacion), usa el dato mas reciente que encuentres y anota su fecha en reasoning. Si el dato tiene mas de 2 dias y puede moverse, baja la confianza.
5. Estima p_yes (probabilidad de que resuelva Si segun las reglas EXACTAS), en [0.01, 0.99]. Usa tasas base y el tiempo restante hasta la fecha de resolucion. Revisa el signo: p_yes es la probabilidad del Si de ESTA pregunta, no de la opcion que creas mas probable.

Salida: forecaster/forecasts/{{FECHA}}.json, un arreglo con un objeto por mercado:
{ "market_id": "...", "p_yes": 0.00, "confidence": "low|medium|high", "reasoning": "corto (max 3 frases)", "key_uncertainties": ["..."], "sources": ["url", ...], "prompt_version": "v2" }

Luego: git add forecaster/forecasts/{{FECHA}}.json; commit; push a claude/forecaster. No toques otros archivos ni otras ramas.
