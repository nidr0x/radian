# Radian MCP de escritura — Diseño

**Fecha:** 2026-08-31  
**Estado:** Propuesta aprobada en conversación para revisión de especificación  
**Alcance:** MCP remoto, D1, sincronización y clientes MCP externos

## Objetivo

Permitir que Codex, Claude y otros clientes MCP consulten y gestionen la cuenta autenticada de Radian sin copiar y pegar prompts, manteniendo D1 como copia central, evitando sobrescrituras silenciosas y permitiendo recuperar cambios destructivos durante 30 días.

## Decisiones aprobadas

- El MCP remoto usa la copia estructurada de `user_data` en D1.
- La lectura conserva el alcance `radian:read`.
- La escritura requiere el alcance OAuth independiente `radian:write`.
- Los conflictos de versión se rechazan; nunca se pisa una copia más reciente de forma implícita.
- Los borrados y reemplazos requieren una previsualización y una confirmación separada.
- Cada mutación destructiva conserva la versión anterior durante 30 días.
- Radian mantiene su funcionamiento local-first y resuelve los conflictos de sincronización mediante su flujo existente.
- El MCP no recibe ni almacena contraseñas, passkeys ni tokens de los clientes.

## Alternativa elegida

Se implementa un MCP remoto con herramientas semánticas y un pequeño contrato de cambios. Es preferible a exponer un editor JSON genérico porque permite validar cada operación según el dominio de entrenamiento, produce resúmenes comprensibles para la confirmación y reduce la probabilidad de que un cliente dañe campos no relacionados.

El servidor seguirá usando Streamable HTTP/JSON-RPC sobre `/api/mcp`. El registro OAuth, la autorización con passkey y los tokens existentes se mantienen. Los clientes externos solo necesitan registrar una vez el endpoint remoto y solicitar el alcance de escritura cuando quieran modificar datos.

## Modelo de autorización

Los metadatos OAuth publicarán ambos alcances:

- `radian:read`: herramientas de consulta actuales.
- `radian:write`: todas las mutaciones, incluidas las destructivas.

La pantalla de consentimiento mostrará por separado “leer” y “modificar”. Un token emitido sin `radian:write` no podrá invocar ninguna herramienta mutante, aunque el cliente envíe `confirm: true`.

El alcance se conserva en el hash del token y se comprueba antes de ejecutar cada herramienta. La autorización continúa ligada al usuario autenticado en Radian y a un cliente OAuth concreto; las consultas y mutaciones siempre filtran por ese `user_id`.

## Herramientas MCP

Las seis herramientas de lectura existentes permanecen compatibles. Se añaden estas herramientas de escritura:

### Cambios normales

- `update_profile`: actualiza únicamente campos permitidos del perfil —gimnasio, objetivo, días, duración, nivel, altura, peso, contexto nutricional y preferencias— y devuelve la nueva versión.
- `replace_routine`: reemplaza los días y ejercicios de la rutina después de validar IDs, series, rangos de repeticiones, descansos y políticas de progresión.
- `record_workout`: crea un entrenamiento completado con fecha, sesión, ejercicios, dificultad y series; no puede editar una sesión histórica existente.
- `add_measurement`: añade una medición corporal fechada.
- `add_checkin`: añade o actualiza el check-in de una semana concreta sin duplicar su clave semanal.

Estas herramientas admiten `baseUpdatedAt` y, si se omite, realizan primero una lectura interna y devuelven una propuesta no aplicada. La aplicación efectiva requiere repetir la operación con la versión recibida, evitando que una instrucción antigua reemplace trabajo nuevo.

### Cambios destructivos o de reemplazo

- `delete_workout`: elimina una sesión por ID.
- `delete_measurement`: elimina una medición por ID.
- `delete_checkin`: elimina un check-in por ID.
- `replace_all_data`: reemplaza la copia completa por un `AppData` validado y limitado a 900 KB.
- `preview_change`: genera una propuesta de cambio sin modificar datos y devuelve un `changeId` de un solo uso.
- `apply_change`: aplica un `changeId` aprobado, con usuario, cliente, versión base y expiración ligados a la propuesta.
- `list_revisions`: lista las versiones recuperables del usuario sin revelar datos de otras cuentas.
- `restore_revision`: restaura una revisión concreta como nueva versión; la copia actual también se conserva antes de restaurar.
- `delete_all_data`: elimina la copia activa, pero conserva la revisión recuperable durante 30 días.

`replace_all_data` y `delete_all_data` solo se ejecutan mediante `preview_change` → `apply_change`. Las eliminaciones de una entidad también pasan por ese flujo; `apply_change` rechaza propuestas caducadas, reutilizadas, de otro cliente, de otro usuario o basadas en una versión obsoleta.

## Contrato de versiones y conflictos

`user_data.updated_at` es la versión observable de la copia central. Cada lectura que pueda preceder a una escritura devuelve `updatedAt`. Toda escritura debe indicar la versión que el cliente leyó:

```json
{
  "baseUpdatedAt": "2026-08-31T21:00:00.000Z"
}
```

El servidor aplica una actualización condicional equivalente a `WHERE user_data.updated_at = baseUpdatedAt`. Si el registro cambió, devuelve `409 conflict` con la versión actual y no modifica nada. Si no existía una copia y el cliente declara una versión, también devuelve conflicto.

Para operaciones que crean un registro nuevo, el servidor sigue validando la versión base para impedir que una conversación antigua añada cambios sobre una copia que el usuario ya modificó sin que el cliente lo sepa.

La respuesta de éxito incluye `updatedAt`, un resumen de lo cambiado y, cuando corresponda, el `revisionId` creado. La respuesta de conflicto incluye solo la copia del usuario autenticado y nunca datos cruzados.

## Revisiones recuperables

La migración añadirá `user_data_revisions` con:

- `id`, `user_id`, `payload`, `source`, `created_at`, `expires_at` y `restored_at`.
- Índice por usuario y fecha de expiración.
- Clave foránea a `users` con borrado en cascada.
- Límite de payload igual al de `user_data`.

Antes de una sustitución, borrado o restauración se inserta la copia activa en esta tabla. Las revisiones expiran a los 30 días y se eliminan de forma oportunista al consultar o mutar el historial. Restaurar nunca modifica una fila histórica: crea una nueva versión activa y conserva la copia que estaba activa justo antes de restaurar.

Los cambios normales también pueden registrar una revisión si sustituyen estructuras completas, como la rutina. Los añadidos de sesiones, mediciones y check-ins no necesitan una copia adicional salvo que el payload completo vaya a reemplazarse.

La misma migración añadirá `mcp_pending_changes` para que la confirmación no dependa de que el cliente conserve o reconstruya el JSON. La tabla guardará `id`, `user_id`, `client_id`, `kind`, `payload`, `base_updated_at`, `summary`, `created_at`, `expires_at` y `used_at`, con claves foráneas a `users` y `mcp_clients`, índice de expiración y consumo atómico de cada propuesta.

## Flujo de datos

1. El cliente MCP obtiene un token OAuth con `radian:read` o `radian:read radian:write`.
2. El cliente consulta el estado o ejecuta `preview_change`.
3. Radian valida el token, el alcance, el usuario y los argumentos de dominio.
4. Para una escritura, el servidor comprueba `baseUpdatedAt`; para una acción destructiva verifica además el `changeId` de un solo uso.
5. D1 guarda una revisión cuando corresponde y actualiza `user_data` mediante una operación condicional.
6. La respuesta devuelve la nueva versión y un resumen apto para el cliente MCP.
7. Si un dispositivo local intenta subir una copia antigua, el endpoint existente de sincronización conserva su conflicto y no sobrescribe la copia central.

El MCP no modifica `localStorage` directamente. Cuando el usuario abra Radian y sincronice, la app verá la versión remota y seguirá el flujo actual de descarga o resolución de conflicto.

## Validación de datos

Las herramientas no aceptarán JSON arbitrario. Se reutilizarán los tipos de `src/types.ts` y las reglas de migración de `src/lib/storage.ts`, añadiendo validaciones explícitas para:

- IDs existentes y relaciones entre días, ejercicios y sesiones.
- Fechas en formato `YYYY-MM-DD` y timestamps ISO válidos.
- Rangos numéricos razonables, series, repeticiones, pesos, descansos y límites de colección.
- Estados de sesión válidos; una sesión registrada por MCP siempre termina como `completed`.
- Perfil y rutina completos en `replace_all_data`, incluyendo `schemaVersion` reconocible.
- Tamaño máximo del payload y ausencia de propiedades desconocidas en las operaciones parciales.

Los errores de validación serán `400` dentro del resultado MCP, sin escritura parcial. Las operaciones multiobjeto usarán una única transacción/batch de D1 para que no quede una copia a medias.

## Cliente y experiencia

El endpoint remoto único funcionará para Codex, Claude y otros clientes MCP que soporten OAuth. Cada cliente hará su registro/autorización una sola vez; después podrá invocar herramientas directamente. La aplicación no intentará configurar la cuenta del cliente ni almacenar credenciales externas.

La documentación explicará dos niveles de permiso: empezar con solo lectura y conceder `radian:write` únicamente al cliente que deba gestionar Radian. Las herramientas destructivas devolverán siempre un resumen de la acción prevista para que el cliente pueda presentarlo antes de llamar a `apply_change`.

## Archivos previstos

- `migrations/0006_mcp_revisions.sql`: tablas e índices de revisiones recuperables y propuestas pendientes.
- `functions/lib/mcpAuth.ts`: alcance de escritura y validación del token.
- `functions/lib/mcp.ts`: definiciones, validadores, propuestas, mutaciones y restauración.
- `functions/api/mcp.ts`: autorización de herramientas y respuesta MCP.
- `functions/api/mcp/*`: solo si OAuth necesita aceptar el nuevo alcance o exponer un flujo de cambios.
- `functions/api/data.ts`: integración de revisiones y contrato de versión compartido cuando sea necesario.
- `functions/types.ts`: tipos de D1 y contexto adicionales.
- `tests/mcp.test.ts`: pruebas de permisos, validación, conflictos, backup, confirmación y restauración.
- `README.md`: configuración para Codex/Claude, permisos, confirmación y recuperación.

No se cambiarán el modelo visual ni las rutas de Radian, y no se tocará el servidor MCP local de `stdio` salvo para documentar claramente que su acceso es distinto del endpoint remoto.

## Pruebas y criterios de aceptación

La implementación estará terminada cuando se cumpla todo lo siguiente:

1. El alcance `radian:read` puede leer como hasta ahora y no puede invocar herramientas de escritura.
2. Un token con `radian:write` puede editar perfil, rutina, sesiones, medidas y check-ins de su propio usuario.
3. Un token de otro usuario no puede leer, mutar, borrar ni restaurar datos ajenos.
4. Una escritura con `baseUpdatedAt` obsoleto devuelve conflicto y deja intacta la copia actual.
5. Un borrado o reemplazo sin propuesta aprobada no cambia D1.
6. Una propuesta aprobada solo puede usarse una vez y caduca en 10 minutos.
7. Borrado, reemplazo y restauración crean una revisión recuperable durante 30 días.
8. `restore_revision` crea una nueva versión activa y no altera la revisión original.
9. Los payloads inválidos, demasiado grandes o con propiedades no permitidas no producen escrituras parciales.
10. Lint, tests, build, compilación de Pages y smoke de producción pasan; el smoke verifica también que el endpoint sin token sigue devolviendo `401`.

## Despliegue y recuperación operativa

La migración se aplicará primero en Preview y se verificará con una cuenta de prueba aislada. Después se aplicará en producción. El código se publicará mediante el flujo de Pages existente y se comprobarán los metadatos OAuth, el rechazo de peticiones sin token y las lecturas MCP antes de habilitar el alcance de escritura para el cliente.

Si una migración falla, no se desplegará la parte que dependa de ella. Si una escritura de usuario entra en conflicto, el servidor rechazará esa operación sin cambios y el cliente podrá volver a leer y proponerla de nuevo. No se implementará una ruta de emergencia que sobrescriba la versión actual ignorando `baseUpdatedAt`.
