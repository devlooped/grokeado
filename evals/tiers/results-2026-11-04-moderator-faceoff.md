# Comparación de evaluadores de nivel — 04/11/2026

Medición por **Vercel AI Gateway de producción** con la suite controlada
(`--suite sufficiency`): 19 expedientes ficticios, sin web, tres repeticiones por
evaluador, mismo prompt y mismos expedientes. Experimento v4. Duración del job:
9 min 18 s, con concurrencia 4. **0 errores de ejecución**, sin escaladas.

```sh
npm run eval:tiers -- --suite sufficiency --moderators spacexai/grok-4.7@medium,openai/gpt-6.1-terra@medium --repeat 3 --concurrency 4 --out test-results/tier-evals/2026-11-04-moderator-faceoff
```

| Evaluador | Correctos | Nivel | Suficiencia | Vacíos esperados | Latencia mediana | Tokens de salida, media | Costo estimado |
|---|---|---|---|---|---:|---:|---:|
| Grok 4.7 `medium` | 52/57 (91%) | 52/57 | 57/57 | 57/57 | 26,8 s | 2.029 | USD 1,036 |
| GPT-6.1 Terra `medium` | 54/57 (95%) | 54/57 | 57/57 | 57/57 | 8,7 s | 632 | USD 0,248 |

El costo estimado usa los precios de lista del catálogo, sin descuentos de caché.
El delta de cuenta observado al cerrar fue USD 0,224; la facturación puede llegar
con demora, así que no se usa para comparar.

## Desvíos

Los ocho desvíos son el mismo: una afirmación de **umbral** ("superó tres
millones") con la cifra explícita, clasificada como Comparación en lugar de Dato.

| Caso | Grok | Terra |
|---|---|---|
| `complete-fact` | 1/3 | 2/3 |
| `excerpt-explicit` | 0/3 | 3/3 |
| `provisional-decoy` | 3/3 | 1/3 |

Sin esos tres casos, ambos aciertan **48/48**: los pares dato/comparación de
ranking y tasa, la cita, la causalidad con solo correlación, los casos normativos,
la instrucción inyectada y la fuente secundaria. La suficiencia y los controles
faltantes fueron correctos en las 114 decisiones.

El prompt define `comparison = combinar datos comparables o calcular`, y ambos
modelos justifican el desvío como "comparar el total con el umbral". Es una
ambigüedad del contrato, no una diferencia de capacidad: la diferencia 4/9 frente
a 6/9 en esos casos no es concluyente.

## Conclusión

En calidad, empate dentro del ruido. Terra `medium` es **unas 3 veces más rápido**
y **unas 4 veces más barato** por decisión, con un tercio de los tokens de salida.
En v2, además, Grok fue el único proveedor con indisponibilidades de Gateway.
Limitaciones: expedientes ficticios y cortos, tres repeticiones, un solo prompt.
Falta confirmar con la suite `claims` (expedientes reales más largos) y
desambiguar el umbral en el prompt antes de medir de nuevo.
