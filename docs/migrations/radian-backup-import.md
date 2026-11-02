# Conversión local de una copia Radian

El conversor trabaja exclusivamente con un archivo de exportación de Radian. No se conecta a D1, Cloudflare ni a servicios externos; no lee credenciales. Antes de ejecutarlo, genera una copia desde la función de exportación de la app y confirma que el identificador de cuenta destino es el correcto.

```sh
node scripts/migrate-radian-to-opengym.mjs \
  --input /ruta/radian-backup.json \
  --account-id ID_DE_CUENTA \
  --output /ruta/radian-import.json \
  --rollback /ruta/radian-rollback.json
```

El comando se niega a sobrescribir cualquiera de los dos resultados y crea ambos archivos en modo exclusivo. Si falla la creación de cualquiera de ellos, elimina los resultados parciales creados por ese intento. Lee la fuente como bytes y exige UTF-8 válido antes de parsearla; el rollback y su checksum copian/verifican exactamente esos bytes, sin normalizar saltos de línea ni perder datos en una conversión de texto. El archivo de importación conserva el marcador de compatibilidad `radian-to-opengym/v1`, el estado transformado, un identificador determinista de migración y checksums. El importador de Radian OSS reconoce ese marcador. Para revertir una importación posterior, restaura ese archivo con el flujo de importación de Radian; esta herramienta no realiza la importación en D1 ni altera la fuente.

## Entradas aceptadas

Se admiten `data.schemaVersion` **1** y **7**. La versión 1 está respaldada por la migración de datos legacy y por las fixtures de `radian-data-v1`; la versión 7 es la que genera `defaultData()` y el exportador actual `serializeBackup()`. Las versiones 2–6 y cualquier otra versión se rechazan hasta que el código o una fixture representativa demuestre su formato. La envoltura de archivo debe indicar `app: "radian"` y contener un objeto `data` con perfil y plan con `days`.

El convertidor también acepta el objeto `AppData` sin envoltura porque los callers de migración local/pairing reciben el estado ya descifrado o guardado. Una sesión debe tener una fecha válida en `dateKey` o `startedAt`; si no, se rechaza el backup completo antes de emitir estado, resumen de conciliación o archivos. No se descartan sesiones ni se genera `d: ""`, que el importador no aceptaría. La conversión no deduce a qué persona pertenece: `--account-id` es el destino que el operador eligió. Ni la envoltura ni el recuento de cuenta de `reconciliation` prueban identidad o permisos.

El JSON y la salida CLI incluyen `reconciliation`, con conteos `source`/`converted` para la cuenta destino, rutinas, ejercicios de rutina, sesiones, ejercicios y series de sesión, peso, medidas y ejercicios personalizados. El resumen contiene solo conteos, sin IDs, nombres ni valores por registro. La exportación representa una cuenta local y el destino es el `--account-id` indicado. Los ejercicios integrados no se duplican como personalizados; por eso el conteo de definiciones de ejercicios fuente puede superar al de ejercicios personalizados convertidos. Diferencias en peso o medidas también pueden deberse a fechas inválidas o campos sin un valor numérico compatible.

La lista `notExportedOrImported` declara explícitamente que passkeys, OAuth/consentimientos, pairing y medios R2 no están en el archivo y no se importan. Este JSON no es un respaldo completo de cuenta: no contiene identidad, permisos, passkeys, tokens, consentimientos, pairing ni bytes de R2, así que no puede restaurarlos. Tampoco convierte referencias de medios. Solo se transfiere el tema del perfil; los demás campos sin equivalente en el formato de importación Radian quedan en la copia exacta de rollback y no se copian al estado convertido. Los registros de energía, molestias y check-ins tampoco pasan al estado convertido. El indicador `active` es local y no se genera desde esta conversión.

Las sesiones antiguas que no tienen `setLogs` se normalizan como hace `createSetLogs`: se crea una fila por serie prevista y calentamiento; si falta `sets`, se usa la prescripción por defecto de ese ejercicio integrado (o 3 si no existe esa prescripción), como `migrateData()`. Si existe el resumen legacy, su `actualReps`, `actualWeightKg` y `completed` se propagan a esas filas. Ese respaldo contiene un único resumen, no valores por serie, por lo que las filas generadas no deben interpretarse como mediciones individuales originales. La conciliación cuenta esas filas normalizadas como fuente/convertidas.

La salida está pensada para revisión y conciliación antes de cualquier importación. Si fuente, checksums, recuentos o relaciones no coinciden con lo esperado, cancela el corte: no cargues el archivo convertido, conserva intacta la fuente y usa el rollback exacto para comprobar bytes y checksum. Esta utilidad no respalda ni restaura tablas D1 u objetos R2; una restauración completa de cuenta necesita esos respaldos por separado y una aceptación distinta. No debe cargarse a producción en esta tarea.

## Migrar el pairing cifrado desde la PWA

En Ajustes → Cuenta → **Encrypted device sync**, introduce el código corto de la copia Radian anterior. El navegador la lee y descifra mediante `/api/sync`, convierte rutinas, sesiones y medidas al formato Radian, omite check-ins/energía/molestias y crea un canal v2. La PWA vuelve a leer y descifrar el canal v2 antes de mostrar el enlace; el Worker solo recibe ciphertext. La copia v1 no se modifica ni se revoca.

Al iniciar, la PWA también convierte `radian-data-v1` local una sola vez al perfil invitado de IndexedDB. Conserva intacta la clave original y no mezcla esa copia con una cuenta abierta. Si el perfil invitado ya contiene rutinas, sesiones, medidas o ejercicios propios, la migración se omite para no resucitar registros eliminados; un perfil vacío solo aporta sus preferencias al merge.

El código maestro v2 queda en `sessionStorage` de esa pestaña para reanudar tras una recarga. Las claves derivadas no se guardan. Al desconectar o revocar se borra el código local; al cerrar la pestaña se pierde y se puede volver a abrir el enlace compartido para reanudar. El enlace contiene el secreto en el fragmento URL, que no se envía en la petición HTTP: compártelo solo con los dispositivos autorizados.
