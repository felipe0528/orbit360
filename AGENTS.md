# Trabajar con Orbit360

Este repositorio incluye el motor abierto de INSV. No requiere Studio, un SDK
propietario ni la configuración de una persona concreta. Lee README.md y
docs/open-engine.md antes de atribuir capacidades a la aplicación.

## Instalar y editar

1. Requiere Node.js ≥22. Ejecuta `node scripts/doctor.mjs --json`.
   `node scripts/bootstrap.mjs --install` descarga el runtime multimedia fijado
   si hace falta; no se necesita `npm install` ni un compilador.
2. Usa `node src/cli.mjs inspect --input "RUTA"` para conocer fuentes, duración
   y calibración. Conserva las parejas `_00_`/`_10_`. El índice `sourceIndex`
   corresponde a la lista de vídeos deduplicada, no a cada archivo de lente.
3. Para un corte: `node src/cli.mjs render --input "RUTA" --output ./resultados
   --format portrait --start 5 --end 7`. Escribe el comando en una sola línea.
   Formatos: portrait, landscape, three-four, square, 360. Los MP4 de entrada
   del CLI deben ser panoramas equirectangulares; para vídeo plano usa la UI/API.
4. Para un montaje escribe un plan como `examples/two-segments.json`, ajusta
   tiempos y encuadres al material real y pásalo con `--plan ruta.json`.
   Cada invocación crea una carpeta nueva e informa el MP4 en JSON por stdout.
   El progreso va a stderr. Los planes son datos: no incluyen shell ni código.
5. Comprueba el MP4 final: duración, dimensiones, audio, intervalos y encuadre.
   Solo la salida equirectangular recibe marcas esféricas V1/V2 verificadas.

Para la interfaz, `npm start` abre un servidor en la dirección local que imprime.
Un agente con navegador puede importar, preparar, revisar fotogramas, cambiar
el montaje y exportar. No expongas localhost a una red para conseguir acceso.

## Evidencia y expectativas

- `inspect` devuelve metadatos técnicos, no una descripción de escenas.
  Antes de contar una historia, revisa imágenes de distintos tiempos y
  direcciones de la esfera. Si careces de visión, dilo; no inventes acciones.
- Puedes extraer imágenes de la copia panorámica local con FFmpeg `v360` o
  usar la vista Encuadre de la app. La calibración y los vídeos son locales;
  no los publiques ni los envíes a un proveedor sin autorización.
- El planificador integrado de Codex solo recibe metadatos y, si el usuario
  activa esa opción, hasta ocho fotogramas frontales. No ve todo el vídeo.
- El motor abierto actual no aplica FlowState, estabilización por giroscopio
  ni corrección de paralaje. No prometas el resultado visual de Studio,
  compatibilidad con todos los modelos o un montaje narrativo automático.
- El repositorio incluye código y una instalación reproducible, no vídeos,
  credenciales, Node.js ni ejecutables de Insta360. Una sesión en la nube
  necesita sus propios archivos y capacidad de ejecutar las herramientas.

## Desarrollo

Ejecuta `npm run check` y `npm test` cuando cambies el procesamiento.
Las pruebas usan medios y calibraciones sintéticos; no añadas archivos de
usuario, seriales, GPS, claves, DLL, encabezados ni modelos propietarios a Git.
Conserva los avisos de terceros. No copies implementaciones de Studio para
presentarlas como código original. Documenta qué se probó y qué falta validar.
