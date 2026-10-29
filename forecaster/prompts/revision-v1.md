# Revision diaria de posiciones abiertas — v1

Proceso aparte del pronostico diario (research-v1.md, congelado). NO cambia pronosticos registrados, compras ni metricas del bot. Sirve para medir si una noticia nueva habria cambiado de lado.

Alcance: posiciones paper abiertas que resuelven dentro de los proximos 3 dias calendario (resuelve <= hoy + 3 dias). Lista en forecaster/revisions/posiciones.json.

Pasos:
1. Mantener posiciones.json: quitar las resueltas (lineas RESOLUCION del log) y agregar las compras nuevas (lineas POSICION del ultimo arranque: de cada una usar SOLO market_id y lado; los nombres salen de las listas CANDIDATO). No usar el precio de entrada.
2. Para cada posicion en alcance, ordenar por tema y hacer como maximo 4 busquedas web por tema (bloqueados: polymarket.com, kalshi.com, manifold.markets, metaculus.com, predictit.org; ignorar cuotas de mercados de prediccion o apuestas).
3. Estimar p_yes_revisada ANTES de mirar el lado abierto ni el pronostico original. Despues comparar.
4. Escribir forecaster/revisions/AAAA-MM-DD.json: arreglo de { market_id, lado_abierto, p_yes_original (ultimo pronostico en forecasts/), p_yes_revisada, direccion ('refuerza' si el cambio favorece el lado abierto: p sube si el lado es SI, baja si es NO; si no, 'debilita'), cambia_de_lado (true solo si la probabilidad cruza 0.5 respecto del pronostico original), resultado_probable (frase), novedades (1 frase con fecha), razonamiento (max 2 frases), fuentes: [url] }.
5. Commit junto con el archivo de pronosticos del dia y push a claude/forecaster. No tocar forecasts/ ni otros archivos.
6. Informar en una linea: posiciones revisadas, cuantas cambian de lado, busquedas usadas.

Calendario de pasadas (desde el 29/10): lun a vie 2 por dia (manana junto al pronostico: AAAA-MM-DD.json; tarde ~19:47 UTC: AAAA-MM-DD-tarde.json); sabado y domingo solo la de la manana; lunes una pasada extra al mediodia (~15:47 UTC: AAAA-MM-DD-mediodia.json). Todas con el mismo alcance (resuelven en <= 3 dias) y sin cambiar pronosticos ni compras.

Ajuste (29/10): la pasada de la manana revisa lo que resuelve en <= 3 dias; la de la tarde (y la del mediodia del lunes, que usa el alcance de la manana) es la mirada final y revisa solo lo que resuelve en las proximas 36 horas. Los mercados con end_date a las 04:59 UTC del dia siguiente cuentan como del dia anterior.

Fuentes: noticias y fuentes oficiales. Una publicacion de redes sociales solo cuenta si es de una cuenta oficial o primaria (el propio organismo, empresa o vocero) o esta confirmada por dos fuentes independientes; nunca rumores. En cada fuente indicar el tipo (noticia, oficial, red_social_oficial).
