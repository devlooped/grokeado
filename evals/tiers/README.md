# Piloto de tiers y suficiencia de evidencia

Experimento aislado con modelos reales por **Vercel AI Gateway**. No cambia la
UI, el procedimiento judicial, la base de datos ni los modelos de producción.
Los [resultados históricos del 30/10/2026](results-2026-10-30.md) corresponden
a la versión 1, anterior al loop. La versión **2** tiene una
[medición real del 30/10/2026](results-2026-10-30-v2.md) que obtuvo 7/7 decisiones
correctas de suficiencia controlada, con un desvío de tier y errores de ejecución
en la suite de afirmaciones. La versión actual es **3**: agrega la resolución de
vacíos cuestionados por el moderador y aún no tiene medición pagada.
Los tests offline no prueban la calidad de juicio del modelo.

## Contrato y responsables

Los cuatro investigadores —Grok, Gemini, Claude y OpenAI— buscan respaldo y
contraevidencia con modelos económicos en esfuerzo medio. Reportan pruebas,
vacíos y problemas de acceso. Las citas deben coincidir con contenido observado
para esa URL; las rechazadas permanecen en auditoría fuera del dossier común.
Cada contribución admitida distingue documento leído de extracto de búsqueda.
La agrupación por URL preserva contradicciones y autores; no prueba independencia
documental ni fiabilidad.

Grok moderador comienza en esfuerzo medio y separa dos ejes:

| Dato interno | Valores | Presentación en español |
|---|---|---|
| `tier` | `fact`, `comparison`, `assessment` | Dato, Comparación, Evaluación |
| `evidence.status` | `sufficient`, `insufficient`, `uncertain` | Suficiente, Insuficiente, Incierta |
| `action` | `verify`, `research_more`, `escalate` | Verificar, Investigar más, Escalar razonamiento |
| `verdict` | `true`, `false`, `unverifiable` | Verdadero, Falso, No verificable |

Todos los identificadores del piloto son ingleses. Las explicaciones, búsquedas
y el informe Markdown son españoles. `presentation.ts` traduce los estados;
no se reutilizan los enums españoles del tribunal de producción.

La suficiencia se justifica con seis controles: cobertura, comparabilidad y
alcance, respaldo, autoridad, contradicciones y acceso documental. Cada uno
registra estado (`satisfied`, `missing`, `uncertain`), motivo y referencias.
También se enumeran aspectos cubiertos y vacíos materiales con `aspect`,
`whyItMatters` y una `researchAction` concreta. Suficiencia exige todos los
controles satisfechos y ningún vacío material. No se decide por votos ni conteos.
Código comprueba IDs, procedencia y coherencia del contrato; el moderador juzga
pertinencia, autoridad y respaldo semántico. Una cita válida no prueba suficiencia.

## Loop de investigación

1. Los cuatro investigadores elaboran el dossier inicial.
2. El moderador evalúa complejidad y suficiencia sobre ese dossier compartido.
3. Si faltan pruebas, las acciones de los vacíos se envían a los cuatro
   investigadores. Se agregan contribuciones sin borrar las anteriores y se
   vuelve a moderar en esfuerzo medio.
4. Solo un juicio sustantivo difícil habilita escalar el moderador a esfuerzo
   alto (`escalationReason: substantive_judgment`). Un PDF inaccesible requiere
   investigación, sin elevar por sí mismo la complejidad ni el esfuerzo.
   Otra solicitud de escalamiento en el mismo dossier detiene el loop.
5. Las evaluaciones comparan baseline económico y tier final con idéntico prompt
   y dossier. Cada evaluador puede cuestionar la suficiencia independientemente.
6. Si una suficiencia aceptada es cuestionada, el moderador resuelve cada vacío
   por separado como material o no (sin votos ni conteos). Solo los materiales
   disparan una ronda de investigación adicional, que comparte el límite de rondas.
   Cada evaluador que cuestionó reevalúa una vez con esa resolución; si mantiene
   la objeción o la suficiencia ya no se acepta, el veredicto efectivo es
   `unverifiable`. La respuesta inicial queda en el informe.

Por defecto hay **dos rondas adicionales**, configurables entre 0 y 5.
El guard predeterminado es USD 8 de consumo de la cuenta; se comprueba antes
de cada llamada pagada, ejecutada secuencialmente. **No es un cap duro**:
facturación tardía, herramientas y actividad concurrente pueden superar el límite.

Los cierres internos son `sufficient`, `iteration_limit`, `budget_exhausted` y
`unresolved_judgment`. Al alcanzar límites se conservan vacíos y pruebas parciales.
Sin habilitación del moderador, con suficiencia cuestionada por el evaluador o
con citas inválidas, `effectiveVerdict` es `unverifiable`. La respuesta original
se conserva para auditar errores. Un desafío del evaluador se resuelve una sola
vez como se describe en el paso 6, sin votaciones.

## Ejecutar

Node.js 22 o posterior y dependencias instaladas. El runner carga `.env.local`
y requiere `AI_GATEWAY_API_KEY` o `VERCEL_OIDC_TOKEN`. No admite
`COURT_AI_MODE=mock`, ni requiere Postgres o un servidor Next.js.

```sh
# Offline: sin Gateway ni credenciales.
npm run test:evals
npm test
npm run typecheck
npm run build

# Pagado: afirmaciones con investigación y evaluadores.
npm run eval:tiers -- --out test-results/tier-evals/sufficiency-v2
npm run eval:tiers -- --case sme-exports --max-research-rounds 1 --max-usd 8 --out test-results/tier-evals/sme-v2

# Pagado: suficiencia aislada, sin búsquedas ni evaluadores finales.
npm run eval:tiers -- --suite sufficiency --out test-results/tier-evals/controlled-v2

# Reanudar v2 con la misma suite y límites.
npm run eval:tiers -- --out test-results/tier-evals/sufficiency-v2 --resume
```

Las afirmaciones reales conservan corte **2026-10-30**. Sus IDs actuales son
`caba-census`, `sme-exports` y `brazil-extension`, antes `censo-caba`,
`exportaciones-pyme` y `brasil-prorroga`. Las referencias, etiquetas y rúbricas
nunca entran en los prompts de los sujetos. Brasil sigue sin veredicto jurídico
binario predeterminado.

La suite `sufficiency` mide siete dossiers ficticios: dato completo, primario
inaccesible, períodos incompatibles, unidades incompatibles, conflicto sin
resolver, comparación completa y dossier vacío. Contrasta tier, suficiencia y
controles faltantes con referencias ocultas al moderador. Admite
`--case period-mismatch`, por ejemplo. No utiliza web ni accede a los dominios `.test`.
No demuestra por sí sola capacidad general.

## Auditoría y resultados

`test-results/tier-evals/<directorio>/`, ignorado por Git, contiene manifiesto,
catálogo, llamadas con fingerprint, dossier acumulado, historial del moderador,
resultados JSON e informe español. Incluye fallos de recuperación y distingue
extractos de documentos leídos. No guarda encabezados de autenticación ni
razonamiento privado.

El runner rechaza reanudar `2026-10-30-pilot` u otra versión **antes de consultar
Gateway o modificar el manifiesto**. El fingerprint incluye versión, modelo,
opciones, prompt, schema e indicador de investigación. Versionar nuevos cambios
de lógica; no incluye todo el código. `--resume` reutiliza llamadas idénticas:
no es una repetición independiente. `--retry-failed` permite repetir intentos
fallidos conservando su traza. No ejecutar dos procesos sobre el mismo directorio.

Un juez GPT-6.1 Sol high califica respuestas finales con rúbrica, sin nombres de
modelos ni tiers. Es juicio LLM, comparte familia con un evaluador y no es ground
truth. Revisar documentos primarios para cualquier conclusión humana.

Código 1 indica errores de ejecución, procedencia o citas, desvíos de tier o
veredicto factual, casos sin suficiencia o evaluaciones incompletas por gasto.
En la suite controlada también indica discrepancias con sus referencias.
Abstenerse es seguro, pero no convierte el experimento en recuperación exitosa.
Conservar las respuestas que fallan para comparar.
