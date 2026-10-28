# Revision diaria de posiciones abiertas — v1

Proceso aparte del pronostico diario (research-v1.md, congelado). NO cambia pronosticos registrados, compras ni metricas del bot. Sirve para medir si una noticia nueva habria cambiado de lado.

Alcance: posiciones paper abiertas que resuelven dentro de los proximos 3 dias calendario (resuelve <= hoy + 3 dias). Lista en forecaster/revisions/posiciones.json.

Pasos:
1. Mantener posiciones.json: quitar las resueltas (lineas RESOLUCION del log) y agregar las compras nuevas (lineas POSICION del ultimo arranque: de cada una usar SOLO market_id y lado; los nombres salen de las listas CANDIDATO). No usar el precio de entrada.
2. Para cada posicion en alcance, ordenar por tema y hacer como maximo 4 busquedas web por tema (bloqueados: polymarket.com, kalshi.com, manifold.markets, metaculus.com, predictit.org; ignorar cuotas de mercados de prediccion o apuestas).
3. Estimar p_yes_revisada ANTES de mirar el lado abierto ni el pronostico original. Despues comparar.
4. Escribir forecaster/revisions/AAAA-MM-DD.json: arreglo de { market_id, lado_abierto, p_yes_original (ultimo pronostico en forecasts/), p_yes_revisada, cambia_de_lado (true si la probabilidad revisada favorece el lado contrario), novedades (1 frase con fecha), razonamiento (max 2 frases), fuentes: [url] }.
5. Commit junto con el archivo de pronosticos del dia y push a claude/forecaster. No tocar forecasts/ ni otros archivos.
6. Informar en una linea: posiciones revisadas, cuantas cambian de lado, busquedas usadas.
