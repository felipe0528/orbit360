# Motor abierto de unión de lentes

Estado: Orbit360 0.3, motor `mei-brown-1`, 13 de octubre de 2026.

Orbit360 puede preparar los INSV probados de ONE X2, X3 y X4 usando su propio lector y motor geométrico, sin instalar ni ejecutar Studio o los SDK de Insta360. El código del motor está en `src/insv.js` y `src/stitch.js`; utiliza Node.js y FFmpeg. Es el motor predeterminado. El adaptador del SDK queda disponible como opción explícita.

Esta implementación es experimental: produce una esfera editable, pero todavía no reproduce la estabilización ni la calidad de unión de Studio. No es un SDK completo de cámara y no proporciona control de captura, transferencia inalámbrica o una implementación de FlowState.

## Alcance comprobado

Las pruebas locales utilizaron un clip por modelo, con sus archivos originales, FFmpeg/FFprobe 6.1.1 del runtime portátil y sin cargar bibliotecas de Insta360:

| Modelo | Entrada probada | Esfera preparada | Duración común de lentes |
| --- | --- | --- | --- |
| ONE X2 | Dos archivos, H.264, 2880 × 2880 por lente, 24 fps | 3840 × 1920 | 1,708333 s |
| X3 | Dos archivos, H.264, 2880 × 2880 por lente, 24 fps | 3840 × 1920 | 1,916667 s |
| X4 | Un archivo, dos pistas HEVC de 3840 × 3840, 24 fps | 3840 × 1920 | 2 s |

Las tres calibraciones produjeron mapas con cero píxeles sin cobertura. De cada esfera se exportaron los segmentos 0,25–0,75 s y 1–1,5 s como un montaje de un segundo: una versión plana 1080 × 1920 y otra 360° de 3840 × 1920, ambas con audio. La salida 360° contiene los metadatos esféricos V1/V2 y fue reconocida por FFprobe. Esto verifica un flujo real de lectura, unión, recorte y exportación; no acredita equivalencia visual con Studio ni una subida real a YouTube. Más resultados en [Validación](validation.md).

Las muestras X2 y X3 tienen un cuadro menos en la segunda lente. El motor usa la duración común más corta y no inventa ese último cuadro. Sus archivos `_10_` carecen de trailer de calibración: la pareja utiliza los metadatos del `_00_`. En X4 se leen las dos pistas del mismo contenedor.

## Lectura del INSV

Un INSV de estas muestras contiene medios MP4 ordinarios y metadatos añadidos al final. FFmpeg decodifica las pistas estándar; `readInsvMetadata` lee únicamente el trailer necesario. El lector contrasta la estructura con [telemetry-parser, commit a94d7ed](https://github.com/AdrianEddy/telemetry-parser/tree/a94d7ed06929eb9145411227c7f187189b96016f/src/insta360) y con un segundo lector local independiente.

El footer observado tiene 72 bytes: padding de 32 bytes, tamaño total del trailer de 4 bytes LE, versión de 4 bytes LE y el marcador ASCII de 32 bytes `8db42d694ccc418790edff439fe026bf`. Se admiten dos formas de localizar registros:

- Registros consecutivos, cuyo descriptor final contiene formato, identificador y longitud LE de 4 bytes.
- Directorio final de registro 0, con entradas de 10 bytes: identificador, formato, longitud LE y desplazamiento LE respecto al inicio del trailer. Este camino admite los espacios de relleno presentes en X4.

El registro 1 contiene protobuf. Se interpretan campos técnicos seleccionados, entre ellos modelo, firmware, dimensiones, ventana de captura y calibración v3. Los campos personales no se incluyen en el resultado. El lector no devuelve números de serie, coordenadas GPS ni el bloque completo de metadatos.

Las lecturas se hacen con acceso `r`. Antes de preparar un material ya importado se comprueban su tamaño y fecha de modificación. No se escribe en los originales. El lector aplica límites de 2 GiB al trailer declarado, 64 KiB al directorio, 2 MiB al registro de metadatos y 4096 registros al recorrido secuencial; no carga el trailer entero en memoria. Rechaza rangos fuera del archivo, protobuf truncado, parámetros no finitos, calibraciones incompletas y ventanas de captura no comprobadas.

La calibración v3 debe describir exactamente dos lentes. No se convierte una versión desconocida en parámetros inventados. Los modelos v1, v2 y v6 no sustituyen a v3 en este motor; v1 solamente puede aportar un círculo de imagen auxiliar. Si una cámara futura conserva los campos admitidos, el lector puede aceptarlos, pero eso no certifica su compatibilidad. Cada cuerpo, firmware, modo y accesorio necesita su propia validación.

## Calibración y proyección

La implementación geométrica es código original de Orbit360. Se basa en el modelo omnidireccional de Mei y distorsión radial/tangencial Brown, no en una tabla fija para cada cámara. La documentación de [calibración omnidireccional de OpenCV](https://docs.opencv.org/4.x/dd/d12/tutorial_omnidir_calib_main.html) describe el modelo de Mei; OpenCV no es una dependencia de ejecución de Orbit360.

Cada lente aporta `xi`, distancias focales `fx/fy`, centro óptico `cx/cy`, tres coeficientes radiales, dos tangenciales y orientación. Los dos centros se almacenan en un espacio de calibración compartido, con las imágenes una al lado de otra. Primero se resta a la segunda lente el ancho correspondiente a la primera; después se transforma desde el sensor al recorte de captura y a la resolución codificada.

Para un sensor de una lente `Ws × Hs`, recorte centrado cuadrado de lado `C` y pista codificada `W × W`:

```text
s = W / C
fx' = fx · s                     fy' = fy · s
cx' = (cx_local − Ws/2) · s + W/2
cy' = (cy       − Hs/2) · s + W/2
```

El recorte es significativo en las muestras reales:

| Modelo | Sensor por lente en la calibración | Recorte de captura | Pista codificada |
| --- | --- | --- | --- |
| ONE X2 | 3040 × 3040 | 2880 × 2880 | 2880 × 2880 |
| X3 | 5952 × 5952 | 5760 × 5760 | 2880 × 2880 |
| X4 | 8000 × 6000 | 5632 × 5632 | 3840 × 3840 |

Escalar solamente por el ancho del sensor daba una unión visiblemente incorrecta en la muestra X4. La implementación exige que los campos de origen y recorte sean coherentes con la calibración; no presupone que cualquier vídeo cuadrado conserva el mismo campo de visión.

Las matrices se expresan como cámara→rig, con ejes derecha, abajo y adelante. Las convenciones angulares de la calibración se contrastaron con el código público de `telemetry-parser`: se compone `Ry(pitch + 90°) · Rz(yaw) · Rx(roll)` y el giro adicional entre las lentes; después se fija la orientación global mediante la pose nominal. La proyección utiliza la transpuesta de esa matriz para llevar un rayo de la esfera a cada lente.

Para el rayo unitario de una lente `(X,Y,Z)`, el cálculo aplicado es:

```text
x = X / (Z + xi)                     y = Y / (Z + xi)
r2 = x² + y²
radial = 1 + k1·r2 + k2·r2² + k3·r2³
xd = x·radial + 2·p1·x·y + p2·(r2 + 2·x²)
yd = y·radial + p1·(r2 + 2·y²) + 2·p2·x·y
u = fx'·xd + cx'                     v = fy'·yd + cy'
```

Cuando el metadato de espejo está activo, se refleja `u` respecto al centro óptico. La traslación entre lentes se conserva como dato técnico, pero la proyección actual no la usa: asume rayos de una escena lejana y no corrige paralaje.

## Mapas, mezcla y codificación

El motor genera cuatro mapas PGM de coordenadas de 16 bits BE y una máscara de mezcla de 8 bits, en bloques de 16 filas. FFmpeg aplica los mapas mediante `remap` y combina ambas imágenes con `maskedmerge`. Las coordenadas se redondean al píxel entero: este camino usa muestreo de vecino más cercano, sin interpolación subpíxel. Los filtros y sus formatos se describen en la [documentación de FFmpeg](https://ffmpeg.org/ffmpeg-filters.html#remap).

Se descartan rayos que exceden 98° respecto al eje de una lente o caen fuera de la imagen. En la zona compartida se usa un peso `clamp((Z + sin(4°)) / (2·sin(4°)), 0, 1)` y se normalizan los dos pesos. **98° y 4° son elecciones experimentales de Orbit360**, no una tabla de parámetros oficiales por cámara. Actualmente son constantes del motor, no controles de la interfaz. Se rechaza una calibración si deja más del 0,1 % de la esfera sin cobertura. Cobertura cero no significa costuras invisibles.

La preparación codifica H.264 con `libx264`, CRF 17 y preset `fast`, en `yuv420p` de 8 bits. El audio disponible se convierte a AAC estéreo de 48 kHz. La exportación final aplica el plan y su propia codificación; por tanto, este flujo no es una copia sin pérdidas del original. Los metadatos 360° se incorporan al MP4 final después del montaje, no al archivo de caché intermedio.

## Resolución y configuración

El valor predeterminado de preparación es 3840 × 1920. Se puede cambiar el ancho con `ORBIT_STITCH_WIDTH` o `stitchWidth` en la configuración local: debe ser múltiplo de 4, entre 1920 y 7680. La altura siempre es la mitad. Por ejemplo, `ORBIT_STITCH_WIDTH=7680` solicita una esfera intermedia de 7680 × 3840. Aumentar la resolución consume más tiempo, disco y memoria, y no crea detalle que no exista en el original.

Esto es distinto del límite de exportación del plan: actualmente cada dimensión final admite como máximo 4096 píxeles. Pedir preparación 8K no habilita una exportación final 8K. La configuración `stitchBackend: "open"` es predeterminada; `"insta360"` selecciona explícitamente el adaptador opcional y requiere el SDK aportado por el usuario. La caché distingue motor, versión y resolución para no confundir sus resultados.

## Límites que afectan al resultado

- No hay estabilización IMU, FlowState, bloqueo de horizonte ni corrección de rolling shutter. Se leen algunos parámetros de IMU, pero no se usan para estabilizar. Una cámara inclinada produce una esfera inclinada.
- No hay estimación de profundidad, optical flow, corrección de paralaje, seguimiento ni unión neuronal. Los objetos cercanos a la costura pueden duplicarse o discontinuarse.
- No se aplican máscaras específicas del cuerpo, protectores de lente, carcasas de buceo o accesorios. El círculo auxiliar del parser no se utiliza todavía como máscara en el renderizador.
- No hay igualación de exposición/color entre lentes, tratamiento HDR/log, conservación de 10 bits, reducción de ruido ni corrección de aberración cromática. El flujo de 8 bits no promete preservar un máster HDR.
- No se validaron X5, X6, modos de una lente, bullet time, cámara lenta, time-lapse ni futuros formatos. Una lectura exitosa de metadatos no sustituye una prueba de imagen, audio y sincronía.
- El motor no añade comprensión visual o narrativa al LLM. La planificación, el análisis de momentos y el control por agentes son capas separadas.

## Procedencia y licencias

- **Orbit360:** lector y generación de mapas escritos en Node.js; proyección y controles disponibles en este repositorio bajo MIT. No ejecutan ni incluyen Studio, DLL, encabezados, modelos neuronales ni tablas de lentes/máscaras de Insta360.
- **telemetry-parser 0.4.0:** se consultó el commit [`a94d7ed06929eb9145411227c7f187189b96016f`](https://github.com/AdrianEddy/telemetry-parser/tree/a94d7ed06929eb9145411227c7f187189b96016f), publicado como MIT OR Apache-2.0. Se conserva su [aviso MIT](../licenses/telemetry-parser-MIT.txt) como atribución de las convenciones contrastadas. No es una dependencia instalada.
- **insv-stitch 0.1.0:** se evaluó el commit [`722b9c7915fc372cdeb73ca25c931cec00f36e13`](https://github.com/BenjaminHenriksson/insv-stitch/tree/722b9c7915fc372cdeb73ca25c931cec00f36e13), MIT, ©2026 Benjamin Henriksson. No se incorporó su código. Sus supuestos específicos de X5 y calibración IMU no se extrapolaron a las cámaras probadas.
- **FFmpeg y sus códecs:** conservan sus propias licencias. Las descargas del runtime portátil no convierten estos componentes en MIT. Véase [Avisos de terceros](../THIRD_PARTY_NOTICES.md).

REA se utilizó para inspecciones documentadas en [Análisis técnico](analysis.md). No se recuperaron algoritmos de Studio con Ghidra ni se usó una descompilación como fuente del motor. Esta descripción de procedencia no afirma una auditoría jurídica, una certificación de desarrollo aislado o una garantía sobre derechos de terceros.

## Contrato para desarrolladores

```js
import { readInsvMetadata } from '../src/insv.js';
import { stitchOpen } from '../src/stitch.js';

// Lectura de metadatos técnicos seleccionados; no modifica el original.
const metadata = await readInsvMetadata(mainInsvPath, { signal });
// metadata.calibration.lenses: xi, fx, fy, cx, cy, distortion,
// rotation (cámara→rig, 3×3 row-major), translation, circle, lensType, mirror.

const result = await stitchOpen(
  { paths: [mainInsvPath, pairedInsvPath] }, // Para X4: solo mainInsvPath.
  intermediateOutputPath,
  { width: 3840, ffmpeg, ffprobe, signal, progress },
);
// result.backend === 'open'; result.stabilized === false.
```

El llamador aporta rutas autorizadas y una salida intermedia distinta de los originales. La aplicación guarda esa salida en su caché; el montaje posterior usa las mismas funciones de recorte y exportación que las demás entradas.
