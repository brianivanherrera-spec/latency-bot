# Regla de seleccion para la prueba de diciembre (CONGELADA desde 2026-11-16)

Aprobada por Brian el 2026-11-16. No editar: cualquier cambio crea regla-v2.md con fecha y motivo.
Se escribe ANTES de ver los resultados de diciembre para que la prueba mida la regla y no el criterio del momento.

Objetivo: elegir 10 mercados para $100 reales (10 USD cada uno). Brian ejecuta las ordenes por una via legal; el bot y Claude nunca operan dinero real.

Fecha de seleccion: 2026-11-30 (o el primer dia habil siguiente), con los datos de la estrategia B de ese momento.

Universo: mercados con pronostico ciego registrado (research-v3 o posterior) en los 7 dias previos a la seleccion.

Filtros (todos obligatorios):
1. Pasa el filtro de B: precio de entrada del lado elegido >= 0,30 y |p del lado - precio de entrada| <= 0,15.
2. Edge positivo: p del lado - precio de entrada - comision > 0.
3. Resuelve entre el 1 y el 31 de diciembre de 2026 (fecha de cierre del mercado).
4. Excluidos: lanzamientos de modelos de IA, rankings de Arena/LMArena, mercados de datos diarios (PortWatch, UKMTO, transitos, conteos) y mercados que resuelven por cuotas de otros mercados de prediccion.
5. Uno por evento (event_id): si hay varios del mismo evento, el de mayor edge.

Diversificacion: como maximo 3 mercados por categoria (politica, mundo, economia, tecnologia, otro).

Orden: de mayor a menor edge (p del lado - precio de entrada - comision). Se toman los 10 primeros que cumplan todo. Si hay menos de 10, se invierte solo en los que haya (no se completa con mercados que no pasan).

Registro: la lista final se escribe en forecaster/diciembre/seleccion.json con market_id, lado, precio visto, p, edge, categoria y fecha, y se sube antes de que Brian ejecute.

Evaluacion: al cierre de diciembre se compara el P&L real contra B paper y contra no hacer nada. Se reporta tal cual, gane o pierda.
