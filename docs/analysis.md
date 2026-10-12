# Análisis técnico de Insta360 y REA

Fecha de inspección: 12 de octubre de 2026. Este informe público omite rutas personales, nombres de vídeos, proyectos, credenciales y contenido audiovisual.

## Decisión de arquitectura

La integración viable utiliza el **Media SDK como dependencia opcional instalada por el usuario** para unir lentes y aplicar estabilización. Orbit360 recibe el resultado panorámico y usa FFmpeg para recortar, ordenar planos, cambiar velocidad, reencuadrar y exportar. Un MP4 panorámico previamente exportado desde Studio también sirve de entrada. El LLM propone un plan JSON con operaciones limitadas; no necesita recibir ejecutables ni bibliotecas de Insta360.

No se encontró una interfaz pública de automatización de Studio que permita asumir exportación por línea de comandos. La aplicación no depende de sus servicios privados ni de sus archivos de proyecto internos.

## Material inspeccionado

| Artefacto | Versión observada | Función |
| --- | --- | --- |
| Insta360 Studio | 6.0.4; recurso de versión 6.0.4.0 | Aplicación de escritorio instalada |
| Camera SDK, Windows x64 | 2.1.8, paquete de 2026-08-28 | Comunicación y control de cámaras; no es el motor de edición |
| Media SDK, Windows x64 | 3.1.5, paquete de 2026-08-19 | Lectura, unión de lentes y procesamiento de medios |
| InsMetaDataSDK, Windows x64 | 2.0.2, paquete de 2026-06-29 | Metadatos; componente separado del ZIP |
| REA | 6.4.0 | Inspección estática local |

Repositorio de análisis: [morluto/rea](https://github.com/morluto/rea), commit [`8fc2043eb8bcedbf34dce064f977e455438635d6`](https://github.com/morluto/rea/tree/8fc2043eb8bcedbf34dce064f977e455438635d6), licencia MIT. Se leyeron sus instrucciones de análisis y se compiló su fuente localmente. No se instaló REA globalmente ni se ejecutó su configuración de agentes.

## Qué se ejecutó con REA

Se completaron cuatro inspecciones estáticas reales: inventario del ZIP original e inventario de recursos PE de Studio, su servicio de exportación y MediaSDK.dll. Estos comandos no ejecutan el software inspeccionado. El entorno utilizado fue Node.js 24.16.0 y npm 11.13.0; la compilación terminó correctamente.

Comandos reproducibles desde un checkout de REA. Las variables representan ubicaciones elegidas por el operador; los JSON de evidencia deben permanecer locales porque conservan rutas absolutas.

```powershell
git checkout 8fc2043eb8bcedbf34dce064f977e455438635d6
$env:HUSKY = '0'
npm ci --ignore-scripts --no-audit --no-fund
npm run compile

$sdkZip = 'C:\RUTA\Windows_CameraSDK-2.1.8_MediaSDK-3.1.5.zip'
$studioExe = 'C:\RUTA\Insta360 Studio.exe'
$exporterExe = 'C:\RUTA\studio-exporter-service.exe'
$mediaDll = 'C:\RUTA\MediaSDK\bin\MediaSDK.dll'

node scripts/rea.mjs inspect-artifact $sdkZip --json > sdk-archive.json
node scripts/rea.mjs inspect-pe-resources $studioExe --max-file-bytes 268435456 --json > studio-pe.json
node scripts/rea.mjs inspect-pe-resources $exporterExe --json > exporter-pe.json
node scripts/rea.mjs inspect-pe-resources $mediaDll --max-file-bytes 268435456 --json > media-pe.json
```

El inventario del ZIP produjo 10 nodos, 10 ocurrencias y 9 relaciones. Identificó los tres ZIP de SDK descritos arriba, además de directorios y metadatos del contenedor. Esa cobertura corresponde al directorio central del ZIP exterior; no equivale a descompilar todo el contenido de los ZIP anidados.

Los tres binarios inspeccionados tienen formato PE32+ y máquina `0x8664` (x64). Studio y su servicio de exportación contienen 12 recursos PE cada uno; MediaSDK.dll contiene 2. REA conserva identidades, rangos y hashes de esos recursos, sin interpretar todos sus contenidos.

| Artefacto | SHA-256 observado |
| --- | --- |
| ZIP original | `0b8d824025ea4d0b97b5914ecfbafda01dfd8f4d5eac6ac57fd6d9a0b9070e0e` |
| Insta360 Studio.exe | `b526e60ff60d893209baf698dbe91eba23586685cc184ed37715d02e5be87266` |
| studio-exporter-service.exe | `a9a15299cfd719d44d1b1203cb1b32e3fc966c828b2f43605edbe736d1880ba3` |
| MediaSDK.dll | `f3f73aaa333cf0efa9780332e661bf50697811ebd8d79b266eba3f8c8cf1d164` |

Identificadores de evidencia REA retenidos en el análisis privado:

- ZIP: `ev_4f9ad7447b71ff0f8bb7f2df21d8270b9ee3bd2d5a663ae957968c54748e76b0`.
- Studio: `ev_b5faab140ce802fe2dd6765f999a53d2855fe64c1204ec80c99c495cbf56d775`.
- Exportador: `ev_e8e87b7666cfbdd2a4c9b30f52924defc7584c8ed6fe9229b039ff7676e04f02`.
- Media SDK: `ev_0d516f9564d4c2aa1f6d07110d5e6917956916eacf84a087a8af0d310619ab0b`.

No se ejecutó Ghidra, IDA ni Hopper. Por tanto, este informe no afirma haber recuperado algoritmos, pseudocódigo, protocolos privados ni comportamiento de ejecución mediante REA.

## Observaciones adicionales de los binarios

Un lector PE local, independiente de REA, enumeró importaciones y exportaciones sin cargar los binarios:

- MediaSDK.dll exporta 105 nombres. Incluye la API C++ `ins::VideoStitcher`, `SetInputPath`, `SetOutputPath`, `SetOutputSize`, `StartStitch`, callbacks de progreso, `EnableFlowState`, `EnableDirectionLock`, opciones de color y codificación H.265. Los nombres usan decoración de MSVC: un adaptador C++ compilado con los encabezados del SDK es una frontera de integración adecuada.
- No aparecieron métodos de yaw, pitch, FOV o keyframes entre esas exportaciones con nombre. Esto orienta el reencuadre hacia el vídeo panorámico y FFmpeg; no demuestra que Studio carezca de esas funciones internas.
- Las importaciones de MediaSDK.dll incluyen MNN, TBB, OpenCV 4.7, ONNX Runtime, bibliotecas CUDA/NPP y runtimes de Visual C++. Copiar únicamente MediaSDK.dll no constituye una instalación completa.
- El servicio de exportación de Studio exporta dos indicadores de GPU y contiene la cadena `ExportMain`. Una cadena estática no establece argumentos, protocolo ni API estable de exportación; no se implementó una integración basada en ella.

La instalación de Studio contiene Qt 6/QML, CEF, FFmpeg y servicios nativos. La asociación de archivos permite abrir INSV/INSP en la interfaz. Sus proyectos contienen estructuras JSON y datos internos, pero el repositorio no publica ni reutiliza esos archivos.

## Dependencias y distribución

El código original de Orbit360, REA, FFmpeg y los SDK de Insta360 son componentes distintos. La licencia MIT de REA no concede derechos sobre Insta360 ni sobre FFmpeg. El repositorio no incluye ejecutables de Studio, DLL del SDK, modelos, encabezados propietarios ni vídeos del usuario. El usuario aporta su distribución del SDK y sus condiciones de acceso; FFmpeg se instala por separado y mantiene la licencia de su distribución.

## Límites de compatibilidad

- Un INSV legible por FFmpeg puede contener lentes sin unir. No debe tratarse automáticamente como una esfera panorámica válida.
- Algunos formatos requieren dos archivos de lentes; otros guardan ambas pistas en un archivo. La documentación oficial describe esta diferencia. El nombre de archivo o la resolución no identifican por sí solos todos los modelos compatibles.
- La presencia de recursos de cámaras en Studio no demuestra compatibilidad de esa cámara con Media SDK 3.1.5. Cada modelo, modo de captura, firmware y accesorio necesita una prueba con material real.
- El reencuadre inicial es fijo por plano. Una secuencia de planos permite cambiar la vista; no equivale a interpolación de keyframes, seguimiento automático de objetos ni edición inteligente basada en comprensión visual completa.
- Una salida 2:1 conserva la geometría equirectangular. Desde Orbit360 0.2 se añaden metadatos Google Spatial Media V1 y V2 tras el montaje; el resultado se verificó con el lector oficial de Google y ffprobe. No se realizó una subida real a YouTube. La implementación sigue el formato público y no procede de descompilar Studio.
- Las pruebas de exportación de Orbit360 se documentan aparte. Un inventario estático no acredita calidad visual, estabilización perfecta ni soporte universal.

## Fuentes oficiales de contraste

- [Referencia del Media SDK de escritorio](https://insta360develop.github.io/Insta360-Developer_Docs/en/x/desktop/media/).
- [Exportación de archivos desde Studio](https://onlinemanual.insta360.com/studio/en-us/operation-guide/file-management/file-export-instructions).
- [Edición y exportación panorámica VR en Studio](https://onlinemanual.insta360.com/studio/en-us/operation-guide/file-management/instructions-for-vr-panoramic-video-editing-and-export).
- [Guía de CLI y evidencia de REA en el commit utilizado](https://github.com/morluto/rea/blob/8fc2043eb8bcedbf34dce064f977e455438635d6/docs/cli.md).

Los encabezados y ejemplos presentes en el SDK local son la referencia utilizada para el adaptador; la documentación web puede describir una revisión diferente.
