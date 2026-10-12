# Orbit360

Editor local y open source para vídeos Insta360, con propuestas de montaje de **Codex** y exportación reproducible a MP4. Interfaz en español. Windows x64 es el entorno objetivo para INSV; el montaje de MP4 funciona con Node.js y FFmpeg.

**Versión 0.2: funcional, experimental.** El código de la aplicación es MIT. Insta360 Media SDK se aporta por separado y no es open source. Este proyecto independiente no está afiliado a Insta360 ni a OpenAI.

## Qué hace

- Importa INSV y agrupa las parejas de lentes `_00_`/`_10_` cuando existen. Acepta también archivos INSV con ambas pistas y MP4/MOV/MKV.
- Une las lentes con Media SDK y solicita FlowState; conserva los originales y crea una copia panorámica local de 3840 × 1920.
- Conecta con tu sesión de Codex CLI para proponer cortes, orden, velocidad, silencio y encuadre fijo por plano.
- Permite revisar y modificar el plan antes de exportar. No ejecuta comandos propuestos por el modelo.
- Recorta intervalos precisos, divide clips y permite duplicar, quitar o reordenar segmentos sin modificar los originales.
- Reencuadra con giro, inclinación y campo visual; exporta 16:9, 9:16, 3:4, cuadrado o equirectangular 2:1 con H.264 y AAC.
- La opción **360° · YouTube / VR** añade metadatos esféricos V1 y V2 al MP4 final, después de los cortes, para subirlo directamente sin un inyector externo.
- Guarda proyecto, caché, planes y exportaciones dentro de `.local/`, excluido de Git. Ofrece progreso y cancelación.

## Inicio rápido

Requisitos: Node.js 22 o posterior; `ffmpeg` y `ffprobe` en PATH con `libx264`, `aac` y `v360`; Codex CLI actualizado con sesión iniciada (`codex login`). La integración se probó con Codex CLI 0.146.1 y FFmpeg 9.0.1. No hay dependencias npm de ejecución.

```powershell
git clone https://github.com/felipe0528/orbit360.git
cd orbit360
npm start
```

Abre **http://127.0.0.1:3600**. También puedes usar `scripts/start.ps1` para arrancar el servidor y abrir el navegador. Si el puerto está ocupado: `$env:PORT = '3601'`.

Para trabajar con INSV, configura tu distribución oficial del SDK:

```powershell
./scripts/setup-sdk.ps1 -ZipPath 'C:\RUTA\Windows_CameraSDK-2.1.8_MediaSDK-3.1.5.zip'
```

Reinicia Orbit360 después de configurar el SDK. El script extrae Media SDK dentro de `.local/sdk` y genera `.local/config.json`. Necesita aproximadamente 2 GB adicionales. No modifica Studio. Se puede usar `-Destination` con otra carpeta privada nueva.

El camino probado usa `MediaSDKTest.exe` de tu SDK como proceso separado. Su código de salida no basta para determinar éxito: Orbit360 comprueba el progreso final y el archivo con ffprobe. El [adaptador C++ propio](native/README.md) es una alternativa experimental para compilar con Visual Studio; no se necesita para el camino probado.

## Flujo de edición

1. Pega rutas locales, una por línea, o busca INSV dentro de una carpeta. El escaneo está acotado a 200 archivos y 30 000 entradas; usa subcarpetas para colecciones grandes.
2. Para MP4, declara si es plano o panorámico equirectangular. La extensión no determina la proyección.
3. Prepara los INSV. La primera vez se procesa el clip completo; puede tardar y ocupar espacio considerable. Las exportaciones reutilizan la copia preparada.
4. Selecciona archivos y describe el montaje, por ejemplo: «Haz un vídeo vertical de 15 segundos, con tres planos de 5 segundos mirando a 0°, 60° y −45°».
5. Genera la propuesta con Codex o crea un plan manual. Revisa tiempos, encuadre, velocidad y audio. La vista «Encuadre» muestra un fotograma de la cámara virtual; el reproductor de fuente muestra el panorama sin proyección interactiva.
6. Exporta. El MP4 queda en `.local/exports/<trabajo>/export.mp4`, junto a su plan JSON. La interfaz permite reproducirlo y descargarlo.

Para probar sin cámara: `npm run demo` genera un patrón sintético de ocho segundos. Importa la ruta indicada como panorámico.

## Recortes y YouTube 360°

Para extraer del segundo 5 al 7, selecciona el clip, escribe **Entrada = 5** y **Salida = 7**, y guarda los ajustes. A velocidad 1× el resultado dura dos segundos. **Dividir clip** crea dos segmentos en el tiempo del original indicado; puedes recortar cada uno, quitarlo, duplicarlo o cambiar su orden. Se aceptan segundos decimales. La precisión efectiva depende de los fotogramas y de la fuente preparada por el SDK.

Elige **360° · YouTube / VR** para conservar toda la esfera, incluso en montajes de varios segmentos. Orbit360 genera un MP4 3840 × 1920 con H.264, AAC y señalización esférica monoscópica de [Google Spatial Media V1](https://github.com/google/spatial-media/blob/master/docs/spherical-video-rfc.md) y [V2](https://github.com/google/spatial-media/blob/master/docs/spherical-video-v2-rfc.md). Se comprueban los metadatos y su reconocimiento por ffprobe antes de declarar completada la exportación. Descarga ese MP4 y súbelo directamente a YouTube; no necesita un archivo de metadatos separado. Los MP4 exportados con versiones anteriores deben volver a exportarse para recibir estas marcas.

La salida se contrastó con el lector oficial de Google; no se hizo una subida real a YouTube. YouTube termina de procesar la reproducción 360° después de recibir el vídeo; consulta su [guía de vídeos esféricos](https://support.google.com/youtube/answer/6178631?hl=es). El reproductor HTML de Orbit360 muestra el panorama extendido, no una esfera interactiva.

Los formatos **9:16, 16:9 y 3:4** generan vídeo plano del encuadre elegido. El exportador elimina marcas esféricas heredadas para evitar que una plataforma lo interprete como 360°. También puedes pedir a Codex: «Conserva del segundo 5 al 7 y del 12 al 15, en ese orden, para YouTube 360°».

## Codex y privacidad

Se usa [`codex exec` con un esquema JSON](https://developers.openai.com/codex/noninteractive/), en modo de solo lectura, con herramientas de shell, aplicaciones, plugins, navegador y búsqueda desactivadas, sin cargar la configuración personal de herramientas. Reutiliza la autenticación de Codex; Orbit360 no almacena ni solicita tu contraseña. El campo modelo es opcional: vacío conserva la elección predeterminada del CLI limpio, no el modelo de otra conversación abierta.

Al generar una propuesta, **se envían a Codex tus instrucciones, nombres de archivo y metadatos técnicos**. No se envían rutas completas, originales ni archivos del SDK. Por defecto no se envían imágenes. Si activas el análisis de fotogramas, se adjuntan dos vistas frontales por archivo de los primeros cuatro seleccionados, hasta ocho imágenes. Son muestras parciales, no un análisis de toda la esfera ni de todo el vídeo. La sesión puede consumir tu cuota de Codex. Sin fotogramas, el modelo no puede identificar personas, acciones o los mejores momentos.

La interfaz y el motor corren en tu equipo. Solo escuchan en `127.0.0.1`; se validan host, origen y un token de sesión para proteger las rutas locales. No expongas el servidor a una red ni mediante un túnel. El modelo devuelve datos; el servidor valida campos, archivos conocidos, tiempos, límites y operaciones antes de construir argumentos de FFmpeg sin shell.

## Compatibilidad y límites

La comprobación de cámaras y resultados está en [docs/validation.md](docs/validation.md). El análisis de REA, Studio 6.0.4 y el SDK está en [docs/analysis.md](docs/analysis.md).

- La compatibilidad de INSV depende de Media SDK, firmware, modo y accesorios. No se promete soporte universal para la cámara más reciente. Actualizar Studio no actualiza automáticamente el SDK que usa Orbit360.
- Límite inicial: 100 planos, una hora de salida, hasta 4096 píxeles por dimensión y 24/25/30/50/60 fps. Preparación INSV a 3840 × 1920: no preserva la resolución nativa 8K.
- Reencuadre fijo por plano; aún no hay seguimiento de sujetos, movimiento suave por keyframes, transiciones, subtítulos, música añadida, control físico de cámara ni importación de proyectos Studio.
- La salida panorámica conserva geometría 2:1 y metadatos esféricos; yaw/pitch/FOV solo afectan la salida plana. El procesamiento final de cada plataforma ocurre después de la subida.
- Los cambios del archivo original se detectan por tamaño y fecha de modificación; debes reimportarlo. No se hace un hash completo de vídeos grandes. Cerrar el servidor interrumpe tareas; al reiniciar se marcan como fallidas y pueden repetirse.
- Caché, imágenes opt-in y resultados se conservan localmente. No hay limpieza automática ni reanudación parcial de renders. Borra solo las carpetas de trabajos que ya no necesites, con el servidor cerrado.

## Desarrollo

```powershell
npm test
npm run check
```

Las pruebas generan vídeos sintéticos temporales y verifican fotogramas y audio de los intervalos seleccionados, velocidad, reencuadre, concatenación, metadatos 360°, validación del plan y protección HTTP. El escritor de metadatos verifica offsets de pistas de 32 y 64 bits y conserva los paquetes audiovisuales sin recodificarlos. FFmpeg es necesario para las pruebas audiovisuales. No usan Codex ni SDK de pago en CI.

Variables opcionales: `ORBIT_DATA_DIR`, `ORBIT_FFMPEG`, `ORBIT_FFPROBE`, `ORBIT_CODEX_JS` (ruta de `@openai/codex/bin/codex.js`) u `ORBIT_CODEX_EXE` (ejecutable nativo, no un `.cmd`). Para SDK: configura `sdkExecutable`, `sdkKind` (`sample` o `bridge`), `sdkModels` y `sdkRoot` en `.local/config.json`. El backend está separado en `media.js`, `plan.js`, `planner.js` y `server.js` para incorporar otros proveedores en el futuro.

## Licencias

[MIT](LICENSE) cubre el código original de Orbit360. [Avisos de terceros](THIRD_PARTY_NOTICES.md). REA se utilizó durante el análisis y no es una dependencia de ejecución. Los binarios, encabezados, modelos y vídeos propietarios no se distribuyen en este repositorio.
