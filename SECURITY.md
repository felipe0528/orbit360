# Seguridad

Orbit360 es una aplicación local de un solo usuario. No está diseñada para servidores públicos ni equipos compartidos sin aislamiento del sistema operativo. El servidor escucha únicamente en 127.0.0.1 y requiere host, origen y token válidos para operaciones sobre archivos.

Los planes de Codex se validan antes del render. No se aceptan filtros FFmpeg, comandos o rutas propuestos por el modelo. Las herramientas externas se ejecutan sin shell. El SDK y FFmpeg procesan medios locales con los permisos del usuario: mantén esas herramientas actualizadas y utiliza archivos de confianza.

Reporta problemas sin publicar vídeos, claves, tokens, rutas personales ni archivos propietarios. Si GitHub ofrece un canal privado de reporte en el repositorio, úsalo; en caso contrario, abre una incidencia descriptiva sin detalles de explotación sensibles para coordinar una vía privada.
