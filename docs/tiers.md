# Tiers de verificación: contexto para continuar

Actualizado: **30 de octubre de 2026**. Proyecto: **Grokeado**.
Directorio de trabajo: `C:\Code\grokeado` (Windows, PowerShell).

Este documento permite retomar la exploración y el piloto desde otra sesión.
El piloto histórico terminó; no hay jobs pendientes. El código del piloto y
este documento se versionan juntos; las trazas locales siguen ignoradas por Git.
Se implementó luego la separación de complejidad y suficiencia
y el loop acotado de investigación en el piloto, por pedido del usuario.
La versión 2 ya tiene una [medición pagada](../evals/tiers/results-2026-10-30-v2.md):
7/7 decisiones de suficiencia controlada correctas, un desvío de tier y ocho
errores de ejecución en afirmaciones. Su política no está validada en general.
Las secciones históricas de resultados siguientes describen exclusivamente v1.

## Objetivo y alcance

El usuario propuso asignar automáticamente modelo y esfuerzo según el tipo de
afirmación: recuperar un dato de INDEC/censos/producción con un modelo económico
y razonamiento medio; usar modelos frontier con esfuerzo alto para ponderar
pruebas, aplicar criterios o evaluar afirmaciones ambiguas.

La hipótesis de flujo fue:

1. Instrucción económica: cada asistente busca respaldo y contraevidencia.
2. Unificación de pruebas, conservando procedencia y contradicciones.
3. Moderador que evalúa el expediente y decide el tier por afirmación.
4. Verificación con el modelo/esfuerzo correspondiente, o más investigación.

Los asistentes evaluadores son **Grok, Gemini, Claude y OpenAI**. Grok también
actúa como moderador; no omitirlo de la matriz. El usuario pidió ejecutar modelos
reales por **Vercel AI Gateway**, y confirmó usar Grokeado como workspace para
todo este trabajo. No continuar en el checkout de CodeAlta donde empezó la
conversación.

Se creó un piloto aislado. No se modificaron la UI, el workflow judicial, la
base de datos ni los modelos configurados en producción.

## Archivos que hay que leer

Todos los enlaces son relativos a este documento.

| Archivo | Contenido |
|---|---|
| [Casos y referencias](../evals/tiers/cases.ts) | Tres afirmaciones, fecha de corte, tiers esperados, rúbricas y URLs de referencia |
| [Contratos y modelos](../evals/tiers/core.ts) | Schemas, grounding de citas, unificación, validación de IDs y selección de modelos |
| [Generación estructurada](../evals/tiers/submission.ts) | Llamadas reales de AI SDK/Gateway y finalización por `submit` |
| [Runner](../scripts/eval-tiers.ts) | Prompts, etapas, caché, gasto, trazas, puntuación y reportes |
| [Tests de contratos](../evals/tiers/core.test.ts) | Procedencia, agrupación, contradicciones y mapping de modelos |
| [Tests del runner](../evals/tiers/submission.test.ts) | Herramientas visibles desde el primer paso y rechazo de respuestas sin entrega estructurada |
| [Loop](../evals/tiers/workflow.ts) | Investigación adicional, límites, escalamiento y abstención efectiva |
| [Prompts](../evals/tiers/prompts.ts) | Suficiencia separada de complejidad, seis controles y vacíos accionables |
| [Presentación](../evals/tiers/presentation.ts) | IDs ingleses y etiquetas españolas |
| [Casos controlados](../evals/tiers/sufficiency-cases.ts) | Siete dossiers ficticios con referencias de suficiencia ocultas al moderador |
| [Tests del loop](../evals/tiers/workflow.test.ts) | Acceso fallido, incompatibilidades, contradicciones, límites y desafíos de evaluadores |
| [Guía de ejecución](../evals/tiers/README.md) | Comandos, metodología y límites |
| [Informe completo](../evals/tiers/results-2026-10-30.md) | Resultados medidos, tablas, hallazgos y limitaciones |
| [Modelos de producción](../src/court/models.ts) | Configuración del tribunal normal; no confundirla con la del piloto |
| [Investigación de producción](../src/court/research.ts) | Herramientas del tribunal normal |

El contrato actual usa identificadores en inglés: tiers `fact`, `comparison`,
`assessment`; acciones `verify`, `research_more`, `escalate`; y
`evidence.status` `sufficient`, `insufficient`, `uncertain`. Conserva `reason`
y `sourceIds`, y agrega seis controles, aspectos cubiertos y vacíos con
`aspect`, `whyItMatters`, `researchAction`. Las explicaciones y vistas siguen
en español. Las etiquetas españolas que aparecen en los resultados siguientes
pertenecen al formato histórico y no se reescribieron.

## Experimento realizado

Fecha de corte de los casos: **2026-10-30**.

| ID | Afirmación resumida | Referencia |
|---|---|---|
| `censo-caba` | Según los resultados definitivos del Censo 2022, CABA superó tres millones de habitantes | Tier `dato`; `verdadero`; total de referencia 3.121.707 |
| `exportaciones-pyme` | Según las ediciones de enero de 2025 de CAME e INDEC, las exportaciones PyME crecieron más en USD corrientes en 2024 que las exportaciones totales de bienes, frente a 2023 | Tier `comparacion`; `falso`; 17,3% frente a 19,4%, diferencia de −2,1 puntos porcentuales |
| `brasil-prorroga` | La prórroga judicial hasta las 19:00 del segundo turno presidencial de Brasil del 25/10/2026 fue ilegal | Tier `evaluacion`; **sin veredicto jurídico binario prefijado** |

El caso brasileño exige distinguir la prórroga de permitir votar después de las
17:00 a quienes ya estaban en fila. También distinguir orden inicial,
aclaraciones, implementación, competencia STF/TSE, tutela urgente, igualdad y
proporcionalidad. Ni la existencia de una orden prueba por sí sola legalidad,
ni una crítica o dificultad de ejecución prueba ilegalidad. No inventar normas,
expedientes ni sentencias. Con evidencia insuficiente, explicitar lo que falta.

Los cuatro investigadores usaron modelos económicos en `medium`, buscaron
independientemente y aportaron hasta seis citas. Las citas debían coincidir con
contenido observado para su URL. La normalización tolera diferencias de formato,
pero no citas recompuestas o de otra fuente. Las citas rechazadas se conservan
en la auditoría y no entran al expediente común.

La unificación es determinista por URL, quitando solo fragmentos `#...` y
preservando autores, textos y orientación. No demuestra independencia documental,
fiabilidad o que la cita implique la conclusión. Por ejemplo, un artículo de
CNN apareció en Brasil con y sin barra final como dos grupos distintos.

Grok moderador `medium` y `high` recibieron el mismo expediente. Después, todos
los evaluadores respondieron al mismo prompt y expediente en el baseline barato
y cada tier distinto seleccionado. Si los moderadores coincidían, no se duplicaba
esa evaluación. Las referencias y etiquetas esperadas se ocultaron a los sujetos.

Un juez separado, **GPT-6.1 Sol high**, recibió la rúbrica y respuestas sin nombres
de modelos ni tiers. Calificó cuatro criterios binarios: fundamentación factual,
criterios pertinentes, razonamiento y calibración. Sus puntuaciones son juicios
LLM; comparte familia con uno de los evaluadores y no constituye ground truth.

**En la corrida histórica no se ejecutó el loop de investigación adicional.**
Se continuó de forma diagnóstica sobre el expediente congelado. El runner v2
sí ejecuta ese loop y no habilita un veredicto efectivo definitivo sin suficiencia.

## Modelos del piloto

Estos IDs estaban disponibles en el catálogo Gateway consultado durante la
corrida. Confirmar disponibilidad antes de futuras ejecuciones.

| Asistente | Dato/instrucción, medium | Comparación, high | Evaluación, high |
|---|---|---|---|
| Grok | `spacexai/grok-4.7` | `spacexai/grok-4.7` | `spacexai/grok-4.7` |
| Gemini | `google/gemini-3.8-flash` | `google/gemini-3.8-flash` | `google/gemini-4-argon` |
| Claude | `anthropic/claude-haiku-5.5` | `anthropic/claude-sonnet-5.5` | `anthropic/claude-opus-5.5` |
| OpenAI | `openai/gpt-6-luna` | `openai/gpt-6.1-terra` | `openai/gpt-6.1-sol` |

En el catálogo consultado había un solo Grok generalista; su carril económico
reduce esfuerzo, no cambia a un supuesto modelo mini. Las opciones se envían en
`xai.reasoningEffort`, `google.thinkingConfig.thinkingLevel`,
`anthropic.effort` u `openai.reasoningEffort`, según corresponda.

## Resultados que no hay que perder

La pasada corregida completó **45 tareas sin errores de ejecución**: 12
investigaciones, 6 moderaciones, 24 evaluaciones y 3 calificaciones de rúbrica.
Reutilizó tres investigaciones exitosas anteriores.

| Caso | Moderador medium | Moderador high | Acción de ambos |
|---|---|---|---|
| Censo | Evaluación | Evaluación | Investigar más |
| Exportaciones | Comparación | Comparación | Verificar |
| Brasil | Evaluación | Evaluación | Investigar más |

Los dos moderadores acertaron 2/3 tiers respecto de la referencia. En el censo,
mezclar versiones, cifras sin período claro y documentos que no pudieron abrirse
provocó sobreescalamiento frente al tier de dato previsto. Pedir más pruebas
podía ser razonable ante ese expediente: el hallazgo es que complejidad de la
tarea y suficiencia documental quedaron mezcladas.

`Medium` tardó **72,59 s** agregados y emitió **5.577 tokens de salida**;
`high`, **169,35 s** y **12.095 tokens**. High tardó 2,33 veces más en total,
con las mismas asignaciones y acciones en estos tres casos. No demuestra
equivalencia general.

| Caso | Baseline económico | Tier seleccionado |
|---|---|---|
| Censo | 4/4 veredictos correctos | 4/4 correctos |
| Exportaciones | 3/4 correctos | 4/4 correctos |
| Brasil | 4/4 `no_verificable` | 4/4 `no_verificable` |

Se acertaron **15/16 etiquetas con referencia factual**. Haiku marcó
`verdict: "verdadero"` en PyME aunque su explicación decía correctamente que
17,3% < 19,4% y que la afirmación era falsa. Alegó una restricción inexistente
del esquema, que sí permite `falso`. Sonnet respondió correctamente. Un JSON
válido no garantiza consistencia entre etiqueta y razonamiento.

Se admitieron **55/65 citas**. Seis de doce investigaciones tuvieron alguna cita
sin correspondencia exacta; eso no prueba automáticamente una invención. Hubo
30 grupos por URL, no necesariamente 30 documentos independientes. Ningún
investigador logró leer una página completa del censo por Browserbase: trabajaron
con extractos de búsqueda, por problemas de PDF/TLS. Hubo dos lecturas exitosas
en exportaciones y cinco en Brasil.

Los 24 evaluadores citaron IDs existentes. Esto valida las referencias del
expediente, no el respaldo de cada inferencia. En Brasil, todos se abstuvieron,
pero la rúbrica detectó diferencias importantes de cobertura y afirmaciones que
excedían la prueba. No interpretar ocho abstenciones como ocho evaluaciones
jurídicas completas. Los modelos más capaces no mejoraron universalmente los
puntajes. Ver la tabla y explicaciones en el informe completo.

El delta acumulado de gasto de la cuenta fue **USD 2,6221**, incluyendo
depuración y repeticiones; la última pasada incrementó aproximadamente USD
1,3890. Son deltas de cuenta, potencialmente con actividad concurrente, no costos
atribuidos exactamente a cada caso o modelo.

El último comando terminó con **código 1 por hallazgos del eval**: 2 desvíos de
tier, 6 investigaciones con alguna cita rechazada y 1 etiqueta factual incorrecta.
Hubo **cero errores de ejecución** en la pasada corregida. No cambiar las
referencias, los prompts o las respuestas para hacer verde la corrida histórica.

## Trazas y cómo ejecutar

Los artefactos completos están localmente en:

```text
C:\Code\grokeado\test-results\tier-evals\2026-10-30-pilot\
```

Incluyen `run.json`, `report.md`, `models.json`, expedientes, reportes por caso,
llamadas con fingerprints, archivos `.previous-...` y manifiestos
`run-before-resume-...`. Conservarlos para auditar intentos y gasto. Ese directorio
está **ignorado por Git**: estará disponible para otra sesión en este workspace,
pero hay que copiarlo por separado si se cambia de máquina o checkout. El informe
Markdown conserva los resultados esenciales sin depender de esas trazas.

Usar Node.js 22 o posterior y las dependencias ya instaladas. Gateway ya estaba
configurado mediante el entorno local. El runner carga `.env.local`/`.env` con
`@next/env` y requiere `AI_GATEWAY_API_KEY` o `VERCEL_OIDC_TOKEN`. No copiar claves
al documento ni imprimirlas. Debe estar desactivado `COURT_AI_MODE=mock`.
El piloto no requiere Postgres ni un servidor Next.js en ejecución.

```powershell
Set-Location -LiteralPath 'C:\Code\grokeado'

# Verificaciones offline; no consumen Gateway.
npm test
npm run test:evals
npm run typecheck
npm run build

# Ver el catálogo actual.
npm run models

# Nueva medición pagada: directorio nuevo, sin reutilizar el piloto histórico.
npm run eval:tiers -- --out test-results/tier-evals/nueva-medicion

# Ejecutar solo un caso en un directorio nuevo (IDs actuales en inglés).
npm run eval:tiers -- --case sme-exports --out test-results/tier-evals/pyme-nueva

# Evaluar suficiencia con dossiers controlados, sin web (pagado).
npm run eval:tiers -- --suite sufficiency --out test-results/tier-evals/sufficiency-control-v2

# Reanudar solo una corrida v2 con la misma suite y límites.
npm run eval:tiers -- --out test-results/tier-evals/nueva-medicion --resume
```

`--retry-failed` permite volver a intentar llamadas fallidas o interrumpidas;
conserva la traza anterior. No lanzar dos procesos sobre el mismo directorio.
El runner actual rechaza reanudar la versión 1 antes de consultar Gateway o
reescribir su manifiesto. No ejecutar sobre el directorio histórico.
Las corridas largas se ejecutaron con `alta job start`; sus resultados llegan
automáticamente. El último job, `job-2cee4a81`, ya terminó: no hay que esperarlo,
hacer polling ni duplicar su ejecución.

El fingerprint incluye modelo, opciones, prompt, schema, indicador de investigación
y una versión interna. **No incluye todo el código del runner**. Si cambia la
lógica del experimento o se busca una repetición independiente, usar un directorio
nuevo o versionar explícitamente el experimento; `--resume` no es una repetición.

El guard predeterminado es `--max-usd 8`, medido contra el consumo inicial de la
cuenta y comprobado antes de cada llamada. No es un cap duro: facturación tardía,
concurrencia y uso ajeno pueden afectar el delta y superar el umbral.

## Problemas técnicos corregidos

- Forzar por nombre `web_search` en `toolChoice` activaba un alias nativo de
  OpenAI (`web_search_preview`) incompatible con la herramienta Gateway.
- El primer intento de corrección restringía `activeTools` a búsqueda. Gateway
  puede ejecutar varias búsquedas server-side en un mismo paso y terminar sin
  tener disponibles `web_fetch` ni `submit`. Esto dejó vacíos los expedientes de
  la pasada intermedia, que no sirve para comparar calidad de modelos.
- La solución en `submission.ts` mantiene las tres herramientas visibles desde
  el primer paso, evita forzar la búsqueda nativa y exige una entrega
  estructurada para considerar exitoso el turno. El test de regresión reprodujo
  el fallo antes de la corrección.

Anthropic puede degradar `toolChoice: required` a `auto` en algunas configuraciones;
el runner comprueba igualmente que se haya llamado a `submit`. Gateway/Gemini
también emitió advertencias de `thoughtSignature`; no causaron errores de
ejecución en la pasada final. No atribuir esa advertencia automáticamente a una
pérdida de estado en el código de la aplicación sin investigarlo.

## Estado del workspace

Archivos propios de este trabajo:

- `README.md` y `package.json`: enlace al piloto y scripts `test:evals`/`eval:tiers`.
- `evals/tiers/`: casos, contratos, generación, tests, guía e informe.
- `scripts/eval-tiers.ts`: runner.
- `docs/tiers.md`: este documento de continuidad.

Ya existían cambios en `next.config.ts` y directorios sin seguimiento `.alta/`
y `.config/`: preservarlos y no incluirlos automáticamente en un eventual commit.
Revisar de nuevo `git status` al retomar. No hubo push ni cambios de producción.

Validación histórica: **35 tests de la aplicación + 5 del piloto**, typecheck y
build pasaron. La v2 agrega tests de contratos, loop, presentación y casos
controlados. Los checks offline no dependen de hacer pasar afirmaciones por
modelos reales, ni validan su juicio semántico.

Validación v2: **35 tests de la aplicación + 21 del piloto**, typecheck y build
pasaron. También se comprobó por CLI, bloqueando la red, que reanudar la corrida
histórica se rechaza sin requests ni cambios en su manifiesto.

## Implementación v2 y trabajo pendiente

Se implementó **separar complejidad y suficiencia** en el piloto. Grok moderador
inicia en `medium`; justifica cobertura, comparabilidad, respaldo, autoridad,
contradicciones y acceso. Un vacío documental dispara investigación, no una
subida automática de tier. Un juicio sustantivo difícil permite un paso `high`.
Una nueva solicitud de escalar en el mismo dossier detiene la decisión.

Los cuatro investigadores reciben las acciones concretas. Sus contribuciones
se agregan al dossier y se vuelve a moderar, conservando procedencia, extractos
rechazados y fallos de acceso. Hay dos rondas adicionales por defecto
(`--max-research-rounds`, entre 0 y 5) y guard de gasto antes de cada llamada.
Los evaluadores pueden cuestionar suficiencia; los desafíos quedan en el
informe, sin otro loop automático. Si no hay suficiencia aceptada, si el
evaluador la cuestiona o si cita IDs inválidos, `effectiveVerdict` es
`unverifiable`; se conserva el veredicto original para auditarlo.

Los IDs actuales de casos son `caba-census`, `sme-exports`, `brazil-extension`.
La suite `--suite sufficiency` contrasta decisiones reales del moderador sobre
siete dossiers ficticios completos, incompletos, incompatibles o contradictorios.
Las referencias se mantienen ocultas. La [medición v2](../evals/tiers/results-2026-10-30-v2.md)
ya ejecutó ambas suites: USD 3,1644 de delta observado y 48 min 40 s; artefactos
en `test-results/tier-evals/2026-10-30-judgment-v2/`. No hay jobs pendientes.
**Pendiente:** ampliar casos/repeticiones y revisión independiente, investigar
las abstenciones excesivas y fallos de ejecución medidos, y decidir por separado
cualquier integración de producción.

Otras cuestiones propias de la continuación: contrastar etiqueta con explicación;
distinguir procedencia, pertinencia e independencia de las fuentes; y ampliar
los casos con repeticiones y evaluación independiente. Conservar el piloto de
referencia para comparar, sin usar sus respuestas esperadas como instrucciones
para los sujetos. Tres casos con una muestra por configuración no permiten
elegir un ganador general por proveedor ni fijar una conclusión sobre la
legalidad de la prórroga brasileña.
