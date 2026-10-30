export const CASES = [
  {
    id: "caba-census",
    claim: "Según los resultados definitivos del Censo 2022 del INDEC, la Ciudad Autónoma de Buenos Aires superó los tres millones de habitantes.",
    expectedTier: "fact",
    expectedVerdict: "true",
    rubric: "Debe consultar resultados definitivos, no confundir población censada con proyecciones ni resultados provisionales. CABA: 3.121.707 habitantes; supera 3.000.000. Una tabla primaria del INDEC basta; no requiere comparar jurisdicciones.",
    references: ["https://censo.gob.ar/index.php/datos_definitivos_total_pais/"],
  },
  {
    id: "sme-exports",
    claim: "Según los informes publicados en enero de 2025 por CAME e INDEC, en el año calendario 2024 las exportaciones de bienes de las PyMEs argentinas crecieron más en dólares corrientes que las exportaciones totales de bienes del país, respecto de 2023.",
    expectedTier: "comparison",
    expectedVerdict: "false",
    rubric: "CAME informó crecimiento interanual PyME de 17,3% en USD y 25,1% en toneladas. INDEC informó 19,4% para exportaciones totales de bienes en USD. Comparar el mismo año calendario, moneda, métrica y edición; 17,3 - 19,4 = -2,1 puntos porcentuales. No confundir variación porcentual con puntos porcentuales, volumen con valor, PyME con MiPyME industrial ni 2024 completo con acumulados parciales. Reconocer que PyME es un subconjunto del total, no grupos disjuntos.",
    references: [
      "https://wdw.came.org.ar/prensa/14101/las-exportaciones-de-las-pymes-cerraron-el-2024-con-un-crecimiento-interanual-del-173-en-dolares-en-tanto-el-precio-promedio-por-tonelada-sufrio-una-disminucion-del-63",
      "https://www.indec.gob.ar/ftp/ica_digital/ica_d_01_25A3C543FBCD/",
    ],
  },
  {
    id: "brazil-extension",
    claim: "La prórroga judicial hasta las 19:00 de la votación del segundo turno presidencial de Brasil del 25 de octubre de 2026 fue ilegal.",
    expectedTier: "assessment",
    expectedVerdict: null,
    rubric: "No hay un veredicto binario preestablecido. Identificar la medida del 25/10/2026 y distinguirla de atender después de las 17:00 a quienes ya estaban en fila. Distinguir orden inicial, aclaraciones, ejecución en secciones aún abiertas, y eventual revisión judicial. Evaluar competencia STF/TSE, base normativa, tutela urgente del sufragio, igualdad y proporcionalidad; exponer argumentos favorables y contrarios. Una orden judicial no prueba por sí sola su legalidad; una crítica, el horario ordinario o un problema de implementación tampoco prueban ilegalidad. No inventar sentencia firme, expediente o artículo. Sin texto primario suficiente, explicitar qué falta y calibrar o suspender la conclusión. Se evalúa calidad del razonamiento, no coincidencia política.",
    references: [
      "https://www.tre-sp.jus.br/comunicacao/noticias/2026/Outubro/eleicoes-2026-em-sp-prorrogacao-da-votacao-teve-apenas-2-496-votos-apos-as-17h-no-2o-turno",
      "https://www.tre-df.jus.br/comunicacao/noticias/2026/Outubro/tredf-informa-quantidade-de-votos-computados-apos-as-17-horas-no-segundo-turno-das-eleicoes",
      "https://agenciabrasil.ebc.com.br/politica/noticia/2026-10/tse-secoes-eleitorais-ainda-abertas-devem-manter-votacao-ate-19h",
    ],
  },
] as const;

export type EvalCase = (typeof CASES)[number];
export const AS_OF = "2026-10-30";
