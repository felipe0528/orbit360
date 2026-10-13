# Instalación y portabilidad

Orbit360 incluye su código de edición y un motor abierto para procesar INSV. El SDK propietario de Insta360 es opcional. Un clon nuevo no necesita archivos de configuración, programas ni credenciales del equipo donde se desarrolló el proyecto.

## Arrancar en otro computador

Instala **Node.js 22 o posterior**, descarga o clona este repositorio y abre una terminal dentro de su carpeta:

```sh
npm run setup
npm start
```

`setup` descarga un runtime multimedia en `.local/runtime`, dentro del proyecto. No instala programas globales. El primer arranque requiere Internet para esa descarga; la edición y exportación se ejecutan localmente. No hace falta ejecutar `npm install` para obtener dependencias JavaScript de la aplicación.

Los comandos equivalentes, útiles para un agente que trabaja directamente con Node, son:

```sh
node scripts/bootstrap.mjs --install
node scripts/bootstrap.mjs --start
```

También se pueden combinar en `node scripts/bootstrap.mjs --install --start`. Ejecutar `node scripts/bootstrap.mjs` sin `--install` solo comprueba el entorno. No descarga software.

La aplicación muestra la dirección local al arrancar. Sus vídeos, caché, proyecto y exportaciones permanecen en este equipo. Para trabajar desde un agente en la nube, hay que poner los vídeos y este entorno de ejecución a disposición de ese agente.

## Diagnóstico para personas y agentes

```sh
node scripts/doctor.mjs
node scripts/doctor.mjs --json
```

El diagnóstico comprueba Node.js, FFmpeg, FFprobe, los filtros `v360`, `remap` y `maskedmerge`, los decodificadores H.264/HEVC y los codificadores libx264/AAC. Devuelve código de salida `0` si están disponibles los requisitos y `1` si falta alguno. El resultado JSON distingue requisitos de herramientas opcionales.

Codex y Python son opcionales. Comprobar la versión de Codex no inicia sesión ni demuestra que la cuenta esté autenticada. Cada persona debe configurar su propio proveedor si desea usarlo; el repositorio no incluye ni copia credenciales. El montaje manual y la exportación no requieren una cuenta de LLM.

Si ya tienes FFmpeg y FFprobe compatibles en `PATH`, puedes arrancar sin descargarlos. Las variables `ORBIT_FFMPEG` y `ORBIT_FFPROBE` permiten indicar ejecutables propios y tienen prioridad sobre el runtime descargado. `--runtime-dir RUTA` permite instalar y usar el runtime en otra carpeta:

```sh
node scripts/bootstrap.mjs --install --start --runtime-dir ./mi-runtime
```

## Dependencias y procedencia

El instalador fija el release **b6.1.1 de ffmpeg-static**, con FFmpeg y FFprobe 6.1.1. Descarga directamente sus archivos publicados, verifica SHA-256 tanto de los archivos gzip como de los binarios descomprimidos y conserva `FFmpeg.LICENSE`, `FFmpeg.README` y `manifest.json`. Los hashes esperados están en `scripts/bootstrap.mjs`; no se aceptan hashes proporcionados por la misma descarga sin contrastarlos con esos valores.

No ejecuta instaladores ni scripts descargados. Si un runtime existente está incompleto o tiene un hash distinto, lo informa sin sustituirlo. Una descarga fallida no se activa como runtime.

El código original de Orbit360 usa MIT. **FFmpeg y sus bibliotecas mantienen sus propias licencias**; descargar un runtime abierto no convierte sus componentes en MIT. Los archivos conservados incluyen avisos y referencias del distribuidor. El repositorio no redistribuye binarios propietarios de Insta360.

Referencias: [release fijado](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1), [procedencia de los binarios](https://github.com/eugeneware/ffmpeg-static#sources-of-the-binaries), [proyecto FFmpeg](https://ffmpeg.org/).

## Plataformas verificadas

| Plataforma | Descarga fijada | Validación |
| --- | --- | --- |
| Windows x64 | Sí | Descarga, hashes, diagnóstico, arranque y pruebas reales de exportación verificados |
| Linux x64 | Sí | Ejecución del runtime descargado pendiente; las pruebas de CI se informan en GitHub |
| Linux arm64 | Sí | Pendiente en hardware correspondiente |
| macOS x64 / arm64 | Sí | Pendiente en hardware correspondiente |
| Otras arquitecturas | No | Se pueden proporcionar FFmpeg y FFprobe propios mediante variables de entorno |

En Windows, el runtime descargado pasó pruebas de recortes por tiempo, concatenación, audio, exportaciones planas 9:16/16:9/3:4 y metadatos esféricos V1/V2. Esas pruebas no equivalen a validar todos los modos y modelos de cámaras Insta360.

El motor abierto debe tratarse según sus capacidades documentadas: no se presupone equivalencia visual con FlowState o con el cosido de Studio. La calidad del cosido, la calibración y la estabilización se evalúan aparte de la portabilidad del instalador.
