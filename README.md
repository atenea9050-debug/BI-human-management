# Talento Humano IA — analítica organizacional multiagente

Aplicación web 100 % frontend (HTML5 + Tailwind CSS + JavaScript vanilla) que analiza archivos CSV/Excel de RR. HH.
(clima laboral, ausentismo, rotación, desempeño, capacitación, solicitudes internas) y entrega **un informe para decidir**:
en qué enfocarse, qué resolver con urgencia, qué monitorear y qué medidas preventivas o estratégicas tomar. No es un documento
estadístico: todo está redactado en lenguaje llano y apoyado en gráficos que explican cada alerta.

## Qué muestra el informe (dashboard y PDF)

1. **Lo que revelan los datos** — un resumen en lenguaje llano («El análisis de los datos reveló que…», «Se encontraron N señales…»).
2. **En qué enfocarse** — de 1 a 3 prioridades.
3. **Alertas con su gráfico** — las alertas ya no van separadas de las visualizaciones: cada una (urgente / importante / vigilar) lleva el
   gráfico que la IA considera más adecuado (barras por grupo, evolución mensual, cuadrante números-vs-comentarios, temas por grupo, tono
   general…) y que el código construye con datos reales. Si hay números y comentarios, **el cruce va primero**. Solo se muestran las más
   relevantes; el resto queda plegado.
4. **Mapa de atención por grupo** — una tabla con colores que muestra qué grupos se alejan de lo habitual (y su tono en los comentarios).
5. **Explora un indicador** — lista desplegable generada por el análisis de los agentes (con selector «Ver por» departamento / sede / cargo,
   explicación de qué mide y cómo leerlo, y su evolución mensual si existe).
6. **Plan de acción** — *resolver con urgencia*, *qué monitorear* (con enlace al indicador) y *medidas preventivas y estratégicas*.
7. **Sobre estos datos y sus límites** — y, si falta una fuente (números o comentarios), un aviso explícito con los datos que conviene recolectar.

El **PDF** conserva esa misma lógica (4 pasos de decisión, alertas con su gráfico, mapa de atención y plan) sin tablas técnicas.
El detalle técnico (hallazgos por agente, estados, modelos, tokens, avisos) queda en un *Anexo técnico* plegado en el dashboard.

## Archivos

| Archivo | Rol |
|---|---|
| `index.html` | Interfaz (Tailwind): diálogo de conexión con la IA (la API Key **no** aparece en el panel principal), contexto opcional, carga de archivos, progreso del Web Worker, estado de cada paso y dashboard (resumen, alertas con gráfico, mapa, explorador, plan). |
| `worker.js` | **Web Worker**: lectura en streaming (PapaParse) o en memoria (SheetJS para Excel), detección de encabezado/tipos, **anonimización local de PII**, métricas, diferencias entre grupos, series, correlaciones y muestras de comentarios anonimizadas y **estratificadas por grupo** (para poder cruzar números y comentarios). |
| `agentsOrchestrator.js` | **Orquestador de 5 agentes** con Gemini API: esquemas JSON estrictos, prompts en lenguaje llano, enrutamiento condicional, validación/saneo de salidas y respaldo por reglas. |
| `insights.js` | De los datos calculados al informe: catálogo de indicadores, gráficos por alerta (elige la IA, construye el código), mapa de atención, explorador de indicadores y ensamblado del informe. |
| `common.js` | Constantes, etiquetas, formatos y utilidades compartidas (incluye `plainify`, una red de seguridad que sustituye la jerga técnica si el modelo se desliza). |
| `pdfExporter.js` | Informe para decidir en PDF (jsPDF) + definición de gráficos compartida con el dashboard (Chart.js). |
| `keyVault.js` | Almacén de la API Key: se vincula una sola vez y queda guardada **cifrada** (AES-GCM, clave no exportable en IndexedDB). Solo expone la clave enmascarada. |

## Cómo ejecutarla

No requiere compilación. Debe servirse por HTTP (los Web Workers y módulos ES no funcionan con `file://`):

```bash
# opción 1: Python
python -m http.server 8765
# opción 2: Node
npx http-server -p 8765
# opción 3: extensión "Live Server" de VS Code
```

Abre `http://localhost:8765/index.html`, carga un archivo y pulsa **Analizar datos**. La primera vez se abrirá el diálogo
**Conexión con Google AI Studio**: pega tu [API Key](https://aistudio.google.com/apikey) una sola vez (acepta tanto el formato
clásico `AIza…` como el nuevo `AQ.…`, y también la línea completa de un `.env` como `GEMINI_API_KEY=…`); se verifica con Google,
se guarda cifrada en este navegador y el análisis continúa solo. En las siguientes sesiones no tienes que volver a ingresarla.
Puedes abrir el diálogo en cualquier momento con el botón de la esquina superior derecha (*IA vinculada · …1234*) para reemplazarla,
cambiar los modelos o pulsar **Olvidar clave**. Las librerías (Tailwind, PapaParse, SheetJS, Chart.js, jsPDF) se cargan por CDN con versión fija.

> **Modo sin IA:** en el diálogo, *Opciones avanzadas*, puedes activar "Modo sin IA". Los 5 agentes usan reglas deterministas locales
> (sin llamar a Gemini), con la misma estructura de informe y el mismo lenguaje llano. También es el respaldo automático si la IA no
> responde o devuelve una salida inválida.

## Arquitectura híbrida

```
Archivo (20-50 MB)
   │  Web Worker (2 pasadas, streaming): perfil de columnas, PII enmascarada, métricas, comentarios anonimizados
   ▼
Resumen estadístico JSON (decenas de KB)           ← el archivo NUNCA sale del navegador
   │
   ▼  Agente 1 · Ingesta, mapeo y enrutamiento → has_quantitative / has_qualitative
   ├─ has_quantitative = true ─► Agente 2 · Números      (si no: status "skipped", bloque = null)
   │     · nombres claros y explicación de cada indicador (alimentan la lista desplegable)
   └─ has_qualitative  = true ─► Agente 3 · Comentarios  (si no: status "skipped", bloque = null)
         · la IA clasifica; el código calcula porcentajes   (2 y 3 en paralelo cuando ambos aplican)
   ▼  Agente 4 · Estratégico: alertas UNIFICADAS (números + comentarios), con el gráfico que él elige,
   │       en qué enfocarse y plan de acción (urgente / monitorear / prevenir). Cruza solo si hay ambas fuentes;
   │       si falta una, lo declara y sugiere qué datos recolectar.
   ▼  Agente 5 · Redactor ejecutivo → resumen para decidir → dashboard + PDF
```

Principios: el **código calcula**, la **IA interpreta y redacta**. Toda cifra tiene un id (`m001`, `g001`, `c001`, `t001`,
`q001`…) y la IA solo puede citar ids existentes; las alertas sin respaldo válido se descartan. Los gráficos nunca los dibuja la IA:
ella elige el tipo entre las opciones que los datos permiten, y si no se puede dibujar, el código usa una alternativa.

## Seguridad y privacidad

- La API Key se guarda de forma persistente **solo en este navegador**, cifrada con AES-GCM (la clave de cifrado es no exportable y
  vive en IndexedDB; en `localStorage` solo quedan los últimos 4 caracteres para mostrar el estado). Nunca se muestra completa en la
  interfaz y se envía únicamente a `generativelanguage.googleapis.com`. Si el navegador no permite WebCrypto/IndexedDB (p. ej. `http`
  en una IP de red), se usa `localStorage` sin cifrar y el diálogo lo avisa; si tampoco hay almacenamiento, solo dura la pestaña.
- Límite honesto: en una app 100 % frontend, quien use tu perfil del navegador (o ejecute código malicioso en la página) podría usar la
  clave. No la vincules en equipos compartidos, restríngela en Google AI Studio y usa «Olvidar clave» cuando ya no la necesites.
  Para un despliegue público se recomienda mover las llamadas a una función serverless que guarde la clave en el servidor.
- Nombres, correos, cédulas, teléfonos y direcciones se enmascaran **antes** de construir cualquier dato para la IA; los comentarios se
  anonimizan (correos, teléfonos, documentos y nombres propios → marcadores); los grupos con menos de 5 registros se agrupan.
- En el plan gratuito de Gemini, Google puede usar lo enviado para mejorar sus productos.

## Modelos

Por defecto `gemini-3.8-flash` con respaldos `gemini-3.6-flash` y `gemini-3.5-flash-lite` (editable en *Opciones avanzadas*).
Si Google está saturado, el orquestador pasa al siguiente modelo y deja al final de la cadena los que no responden durante esa ejecución.
Verifica los ids vigentes en la documentación de Google AI Studio.

## Datos de ejemplo

`samples/` contiene CSV de prueba: `clima_rrhh_completo.csv` (números + comentarios + datos personales), `solo_cuantitativo.csv`,
`solo_cualitativo.csv` y `ruido_latin1.csv` (título sobre el encabezado, `;`, coma decimal, Latin-1, fechas mixtas y nulos simbólicos).
