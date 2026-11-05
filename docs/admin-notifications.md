# Notificaciones de administración

Las notificaciones se guardan en PostgreSQL y solo pueden consultarlas, marcarlas como leídas o eliminarlas usuarios con el rol exacto `Admin`. El escudo muestra un punto cuando hay notificaciones sin leer; el panel permite recorrer el historial y marcarlo como leído. El estado de lectura es compartido entre administradores. Marcarlo no borra el historial; cada notificación también puede eliminarse individualmente desde el panel, con confirmación.

Se registra un aviso cuando un caso pasa a fallido, incluso si falla antes de abrir la instrucción o si el workflow no pudo iniciarse. Los mensajes son genéricos o de categorías conocidas: no copian mensajes arbitrarios de proveedores, credenciales ni contenido enviado. Para el diagnóstico detallado se consultan los logs de Vercel. No se importan fallos anteriores al despliegue y no se capturan todos los errores de Vercel.

Mientras un administrador usa el sitio, se consulta el snapshot configurado en Vercel al entrar y cada cinco minutos con la pestaña visible. Se avisa si falta, no se puede consultar, no está disponible, vence en siete días o ya venció. El aviso se persiste solo cuando cambia la condición, por lo que leerlo no lo recrea en cada consulta; un problema que desaparece y vuelve a ocurrir sí genera otro aviso. Esta comprobación no es un cron: si ningún administrador visita el sitio, se hace en la próxima visita. Requiere que el despliegue pueda usar las credenciales OIDC de Vercel para consultar el snapshot.

El punto se actualiza al consultar y luego aproximadamente cada 30 segundos mientras la pestaña está visible. Los casos que ya estaban atascados antes de esta funcionalidad no se recuperan automáticamente.
