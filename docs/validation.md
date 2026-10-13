# Validación local

Fechas de pruebas: 12 y 13 de octubre de 2026. Entorno: Windows x64. La versión 0.3 añade pruebas sin SDK con FFmpeg/FFprobe 6.1.1 portátil; las secciones históricas de 0.1/0.2 usan MediaSDK 3.1.5 y MetadataSDK 2.0.2. Las fuentes originales se abrieron en modo de lectura. Este documento omite rutas personales, nombres de clips, números de serie, coordenadas y contenido audiovisual privado.

## Versión 0.3: procesamiento sin SDK ni Studio

Se ejecutó el motor `mei-brown-1` con un clip real por modelo, sin invocar DLL, ejecutables, modelos o encabezados de Insta360. La calibración se obtuvo con el lector Node del propio repositorio. Se usaron FFmpeg y FFprobe 6.1.1 descargados por el bootstrap y verificados por SHA-256, sin utilizar el FFmpeg 9 instalado globalmente para estas tres pruebas.

| Modelo | Entrada | Panorama preparado | Resultado de edición |
| --- | --- | --- | --- |
| ONE X2 | Pareja H.264, 2880², 24 fps | 3840 × 1920, 41 cuadros, 1,708333 s, audio | Dos intervalos, MP4 vertical y 360° aprobados |
| X3 | Pareja H.264, 2880², 24 fps | 3840 × 1920, 46 cuadros, 1,916667 s, audio | Dos intervalos, MP4 vertical y 360° aprobados |
| X4 | Dos pistas HEVC, 3840², 24 fps | 3840 × 1920, 48 cuadros, 2 s, audio | Dos intervalos, MP4 vertical y 360° aprobados |

Cada montaje conserva 0,25–0,75 s y 1–1,5 s: 1 s final, H.264 + AAC. Se comprobaron 1080 × 1920 plano sin marcas esféricas y 3840 × 1920 con V1/V2 reconocidos por FFprobe. El lector oficial de Google Spatial Media también reconoció el MP4 X4 como esfera completa monoscópica con ambas versiones de metadatos. No se realizó una subida a YouTube.

Los mapas de las tres calibraciones no dejaron píxeles sin cobertura. Se inspeccionaron imágenes decodificadas: representan la esfera completa, pero muestran inclinación de cámara y defectos de paralaje en la zona de unión. **No tienen estabilización y no se consideran equivalentes al resultado de Studio.** Son tomas breves; no prueban sincronía o calidad en grabaciones largas ni accesorios o modelos distintos.

La API local preparó también el X3 con el motor abierto, identificó explícitamente `backend: open` y `stabilized: false`, devolvió una vista plana 9:16 con HTTP 200 y conservó el plan personal existente. Una caché generada por el SDK no se utilizó como prueba del motor abierto. La comprobación visual del navegador de esta revisión no pudo completarse: el controlador devolvió `ERR_BLOCKED_BY_CLIENT` para localhost; no se presenta como aprobada.

Las pruebas sintéticas añadidas verifican el parser secuencial e indexado, recorte de sensor, matrices, límites de lectura, ausencia de datos personales en su salida, originales intactos, coordenadas PGM de 16 bits, polos, cobertura y mezcla. Una prueba completa genera dos lentes de colores y audio, añade un trailer válido, ejecuta el motor y comprueba los hemisferios resultantes. Las pruebas del CLI verifican planes portables, dos cortes, JSON, carpetas de salida exclusivas y duración común tanto en parejas como en un archivo de dos pistas.

El bootstrap se probó en Windows x64: descarga verificada, licencias conservadas, diagnóstico, reutilización sin descarga, arranque HTTP 200 y cierre. No necesita una cuenta Codex para editar o exportar. Los detalles de instalación están en [Portabilidad](portability.md); fórmulas, fuentes y límites en [Motor abierto](open-engine.md).

## Pruebas históricas con SDK: unión de lentes y FlowState

Los modelos y las versiones de firmware se comprobaron con `MetaDataSDKDemo`, además de inspeccionar las pistas con FFprobe. La exportación usa el ejecutable privado `MediaSDKTest.exe`, óptica `optflow`, FlowState activado y salida panorámica de 1920 × 960. El resultado se comprueba con FFprobe y se decodifica una imagen con FFmpeg.

| Cámara | Firmware de la muestra | Fuente inspeccionada | Resultado de la prueba |
| --- | --- | --- | --- |
| ONE X2 | `v1.0.62_build2` | Dos archivos H.264 de 2880 × 2880, 24 fps; unos 1,75 s | Exportación aprobada: H.264, 1920 × 960, 24 fps, 41 fotogramas, AAC y 1,770667 s. El SDK informó `flowstate: ON`. |
| X3 | `v1.0.35_build2` | Dos archivos H.264 de 2880 × 2880, 24 fps; unos 1,92 s | Exportación aprobada: H.264, 1920 × 960, 24 fps, 46 fotogramas, AAC y 1,984 s. El SDK informó `flowstate: ON`. |
| X4 | `v1.4.8_build1` | Un archivo con dos pistas HEVC de 3840 × 3840, 24 fps y 2 s | Exportación aprobada: H.264, 1920 × 960, 24 fps, 49 fotogramas, AAC y 2,041667 s. El SDK informó `flowstate: ON`. |

Las tres exportaciones aprobadas usaron `h264_nvenc` y tardaron aproximadamente 142 segundos (X2), 68 segundos (X3) y 67 segundos (X4) en esta máquina. Estos tiempos corresponden a estas pruebas; no son una estimación general del rendimiento ni una promesa de procesamiento en tiempo real. Se inspeccionaron imágenes de los tres panoramas. No se realizó una evaluación exhaustiva de calidad de costura, horizonte o estabilización en tomas largas.

Las pequeñas diferencias de duración entre fuente y salida quedan registradas arriba. La exportación conserva audio y el SDK puede ajustar los tiempos del contenedor. No se afirma igualdad exacta de número de fotogramas o duración.

## Compatibilidad declarada y alcance

El `CameraType` del CameraSDK 2.1.8 enumera ONE X, ONE R, ONE RS, ONE X2, X3, X4, X5, X4 Air y X6. No enumera «X5 Air». Que un modelo aparezca en el paquete no valida todos sus modos, resoluciones, firmwares o accesorios, ni demuestra que se haya probado físicamente aquí. X5, X4 Air y X6 no cuentan con muestras verificadas en estas pruebas.

La aplicación permite usar un SDK obtenido y actualizado por el usuario. Su arquitectura separa el adaptador del SDK, la unión de lentes, el reencuadre y la edición para poder ampliar compatibilidad. Esto no constituye una garantía universal de compatibilidad futura.

## Adaptador C++ experimental

El código de `native/` se escribió para las firmas públicas inspeccionadas del MediaSDK 3.1.5. No se pudo compilar en la máquina de desarrollo porque no estaban disponibles MSVC ni CMake. La prueba del ejecutable del proveedor no equivale a una compilación o validación del adaptador original.

La finalización asíncrona se interpreta cuando el progreso alcanza 100, siguiendo el ejemplo incluido por el proveedor. El estado de los callbacks permanece vivo durante la destrucción del objeto de unión. La API pública inspeccionada no proporciona otra operación de espera final. Por ello, el proceso superior también debe comprobar que el resultado existe, se puede abrir con FFprobe y contiene vídeo válido.

El sample puede terminar con código cero después de ciertos errores de exportación. También imprime mensajes internos de nivel de error en trabajos que sí terminan correctamente. La aplicación exige una señal de progreso del 100 % y validación del archivo; no considera que cualquier texto de diagnóstico sea un fallo fatal.

## Instalación privada del SDK

`setup-sdk.ps1` y `build-native.ps1` pasaron la comprobación sintáctica de PowerShell. Con archivos de prueba aislados se verificó:

- Extracción de un ZIP de MediaSDK y de un ZIP exterior que lo contiene.
- Conservación de otras opciones de configuración al guardar el SDK.
- Rechazo de un destino existente para evitar sobrescribir instalaciones.
- Rechazo de rutas de ZIP que intenten escapar de la carpeta de extracción.

Los ZIP, DLL, bibliotecas, modelos, encabezados propietarios, muestras originales y resultados privados quedan fuera del repositorio público. El paquete inspeccionado no incluía un archivo de licencia o guía de redistribución; no se ha inferido permiso para redistribuirlo.

## Aplicación completa y Codex

Se completó el flujo real por la API local de Orbit360 con una fuente X3: importación de la pareja INSV, preparación panorámica de **3840 × 1920**, generación del plan con la sesión autenticada de Codex CLI 0.146.1 y exportación final **1080 × 1920, 24 fps, H.264 + AAC, 1,5 segundos**. Codex recibió solo instrucciones y metadatos, sin fotogramas. El plan solicitó yaw 30°, pitch 0°, FOV horizontal 90° y velocidad normal. El MP4 se comprobó con ffprobe y una imagen decodificada; el servidor respondió 206 a una petición HTTP Range de reproducción.

También se probó Codex con material sintético para proponer un montaje vertical de dos planos y tres segundos. Devolvió JSON válido con los tiempos y ángulos solicitados. No se probó una llamada real a Codex con imágenes; la opción de fotogramas está implementada, pero su resultado depende de las capacidades y acceso del modelo seleccionado.

La validación inicial pasó 6 pruebas sin omisiones en Windows: validación estricta del plan, proyección, rechazo de campos/archivos desconocidos, protección de la API local y exportaciones FFmpeg reales con cortes, velocidad, audio, silencio, concatenación y formato vertical. Incluye detección de reemplazo de originales por tamaño/fecha. La ampliación de la versión 0.2 se describe debajo.

La interfaz se verificó en navegador a tamaño de escritorio y a 390 píxeles de ancho. Se probaron errores de importación, guardado de ajustes, duplicación, reordenación y eliminación de planos; la vista previa de un montaje vertical produjo una imagen de 270 × 480. Se corrigieron el desbordamiento móvil y una restricción errónea sobre tiempos decimales. La consola no mostró errores durante esas comprobaciones.

La exportación probada no acredita seguimiento de sujetos, keyframes, edición de tomas largas ni compatibilidad con cada modo de cámara. Esas funciones y matrices de cobertura siguen fuera de lo validado en esta versión.

## Versión 0.2: segmentos y metadatos de YouTube 360°

El MP4 final recibe el UUID XML de Spherical Video V1 y las cajas `sv3d` y `st3d` de V2, con proyección equirectangular completa y modo monoscópico. Se añaden después de concatenar los segmentos, se conservan los paquetes de audio y vídeo y se corrigen los offsets `stco`/`co64`. El índice `moov` permanece delante de los datos cuando FFmpeg prepara faststart. Las exportaciones planas eliminan estas marcas si la fuente las traía.

Se exportaron dos intervalos de una fuente X3 ya preparada: 0–0,5 s y 1–1,5 s. La prueba por la API de la app produjo **3840 × 1920, H.264 + AAC, 24 fotogramas**, con duración de pista de vídeo de **1,012 s** por los tiempos de concatenación y codificación de audio. FFprobe identificó `Spherical Mapping: equirectangular`. La descarga HTTP fue idéntica por SHA-256 al archivo generado y la reproducción parcial respondió 206. El montaje personal existente no se sustituyó durante esta prueba.

Se contrastó el MP4 con el lector oficial de [Google Spatial Media, commit 2308497](https://github.com/google/spatial-media/tree/2308497c39bb604a7c3ba56ac17e302f2b1b6a96). Reconoció tanto V1 (`Spherical=true`, `Stitched=true`, `ProjectionType=equirectangular`, panorama completo de 3840 × 1920) como V2 (modo 0 mono, `EQUI` sin recorte, orientación inicial neutra). Esta validación es independiente del lector propio de Orbit360. **No se realizó una subida real a YouTube**; su procesamiento remoto no se presenta como verificado.

La suite ampliada comprueba:

- Una fuente sintética de 20 s a 30 fps con código visual de tiempo: 5–7 s produce los 60 fotogramas exactos seleccionados. Se verifican todos los fotogramas en 9:16, 16:9, 3:4 y 2:1.
- Dos intervalos 5–7 y 12–15 s conservan orden, 150 fotogramas y procedencia temporal del audio. Inicio dentro de un fotograma y duración de AAC dentro de 50 ms. El original conserva SHA-256, tamaño y fecha.
- Metadatos V1/V2 reconocidos por FFprobe, igualdad de hashes de cada paquete audiovisual y de los fotogramas decodificados antes y después de añadirlos, con `moov` inicial o final.
- Escritura idempotente, salida exclusiva, cancelación con limpieza, rechazo de archivos truncados o fragmentados y tablas de offsets inválidas. Una prueba con archivo virtual de más de 4 GiB verifica la promoción a `co64` y lecturas acotadas a 1 MiB; no sustituye una exportación real de esa duración/tamaño.
- Reimportación de un MP4 360° y exportación plana sin señalización esférica heredada. Límites decimales de segmentos de 0,1 s sin rechazo por redondeo binario.

La interfaz se comprobó en escritorio y a 390 × 844 píxeles: selección de 3:4, recorte 5–7, división en 6,125 s, duplicar, reordenar y quitar; se rechazó una división fuera del interior del clip sin modificar el plan. El resultado 360° muestra confirmación de metadatos solo tras verificarlos en el MP4 final.

El escritor acepta MP4 no fragmentado con una pista visual compatible e índice `moov` de hasta 64 MiB. Los tiempos de recorte se aplican a la copia panorámica preparada. La prueba sintética no demuestra igualdad exacta de tiempo/fotogramas entre cada INSV original y la preparación del SDK, ni precisión de fuentes de frecuencia variable.
