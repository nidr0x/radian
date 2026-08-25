# Radian

Radian es una PWA local-first para registrar entrenamientos con la mínima fricción posible. Está pensada para uso móvil durante la sesión: se puede marcar `Fácil`, `Bien`, `Difícil` o `No pude` sin introducir cargas ni repeticiones.

## Ejecutar

```bash
npm install
npm run dev
```

Comandos de calidad:

```bash
npm run lint
npm run lint:functions
npm test
npm run build
npx wrangler pages functions build functions
```

La primera vez, Radian muestra una configuración breve para elegir objetivo, días, duración y nivel. La altura y el peso son opcionales, se guardan solo en el dispositivo y se pueden omitir. La configuración se puede repetir desde Perfil. Durante una sesión se puede repetir el registro anterior, saltar un ejercicio, deshacer el último avance y salir conservando la sesión en curso.

## Desplegar en Cloudflare Pages

El proyecto incluye `wrangler.jsonc`, el fallback para la SPA y cabeceras de seguridad/cache en `public/`. En Cloudflare Pages usa:

- Build command: `npm run build`
- Build output directory: `dist`
- Production branch: `master`

También puedes desplegar la carpeta generada con Wrangler:

```bash
  npm run build
  npx wrangler pages deploy dist --project-name=radian
```

El repositorio incluye un workflow de GitHub Actions. Cada push a `master` ejecuta las comprobaciones, construye la PWA y publica una nueva versión en Cloudflare Pages.

La aplicación expone `GET /api/health` para comprobar que la Function está activa y que puede consultar D1. Tras un despliegue, puedes verificarlo con:

```bash
curl -fsS https://radian.nidr0x.win/api/health
```

## Sincronización opcional entre dispositivos

La app sigue funcionando sin backend. Si quieres compartir los datos entre el móvil y el ordenador, el proyecto incluye la Pages Function `/api/sync` y la migración `migrations/0001_sync_records.sql` para Cloudflare D1.

1. Crea una base D1 para la sincronización si estás preparando un fork:

   ```bash
   npx wrangler d1 create radian-prod
   ```

2. En Cloudflare Pages, añade una vinculación D1 llamada `DB` a los entornos de producción y preview, usando esa base. El despliegue oficial de Radian ya usa `radian-prod` y tiene configurado su identificador en `wrangler.jsonc`.
3. Aplica la migración en remoto:

   ```bash
   npx wrangler d1 migrations apply radian-prod --remote
   ```

4. En Radian, abre `Perfil → Sincronizar dispositivos`, genera un código y conecta el primer dispositivo. Introduce el mismo código en el segundo y elige si quieres descargar la copia remota o subir sus datos locales.

El código funciona como llave de acceso a esa copia. El contenido se cifra en el dispositivo antes de subirlo; puedes revocar el código para borrar la copia remota y cortar el acceso de otros dispositivos. No lo compartas. Si ejecutas solo `npm run dev`, la app permanece en modo local-first porque Vite no sirve las Pages Functions.

El modo local no necesita variables secretas ni una base de datos. Si activas las cuentas passkey, el despliegue necesita la base D1 y los secretos descritos abajo.

Las Functions de autenticación tienen un límite distribuido de 20 solicitudes por minuto y dirección IP por ruta. El binding `AUTH_RATE_LIMITER` está definido en `wrangler.jsonc`; si falta en un entorno local, la autenticación permanece operativa para facilitar el desarrollo.

## Decisiones del MVP

- React + TypeScript + Vite, con backend opcional mediante Pages Functions y D1.
- Estado persistido en `localStorage` detrás de `src/lib/storage.ts`, con `schemaVersion` y funciones de migración preparadas para sustituir el adaptador por IndexedDB.
- Las sesiones guardan una instantánea de la programación vigente al iniciarse. Editar la rutina no altera los históricos.
- El motor de recomendaciones de `src/lib/recommendations.ts` es determinista y testeable sin UI.
- Las sesiones nuevas calculan una prescripción explicable por ejercicio: doble progresión, progresión lineal, mantenimiento, descarga tras tres sesiones atascadas y bloqueo si hay molestias. La rutina permite elegir la regla, el salto de carga y hasta tres series de calentamiento.
- Las series de calentamiento quedan identificadas en el histórico y no cuentan para progresión, volumen, marcas ni resúmenes. Mientras hay una sesión activa, la PWA solicita el bloqueo de pantalla cuando el navegador lo permite.
- Hoy y Rutina muestran la última señal registrada y una acción concreta para la próxima sesión; si aparece una molestia, se pueden probar variantes del mismo grupo sin cambiar la rutina original.
- El backup exporta todo el estado como JSON. La importación requiere confirmación antes de sustituir los datos locales.
- El service worker y el manifest permiten instalarla como PWA y abrir la carcasa sin conexión. Sin D1, los datos no salen del dispositivo.
- Las tarjetas incluyen una imagen local individual por ejercicio, con el mismo estilo visual y pasos numerados de ajuste, ejecución y alternativas si aparece una molestia. Funcionan sin conexión junto con el resto de la carcasa PWA.
- Progreso incluye adherencia semanal, volumen reciente, mejores cargas, sesiones del mes, volumen por grupo muscular y un resumen semanal copiable para revisarlo juntos.
- Perfil incluye texto grande, instalación PWA cuando el navegador lo permite y estados claros para el modo local y la sincronización.

La primera versión no cuenta calorías, no registra comidas, no incluye cuentas basadas en contraseña ni proveedor de IA. Mantiene el modo local, el código de emparejamiento cifrado y las cuentas opcionales con passkey para la sincronización estructurada en D1.
## Cuenta, D1 y passkeys

Radian puede seguir funcionando sin cuenta y guardar los datos en el dispositivo. Si quieres sincronizar entre dispositivos, la cuenta opcional usa una passkey (WebAuthn) y guarda la copia estructurada en Cloudflare D1.

Para preparar el entorno de Cloudflare:

1. Crea una base de datos D1 llamada `radian-prod` y sustituye el identificador de ejemplo en `wrangler.jsonc` por el suyo. En el despliegue oficial, la base ya está creada y configurada.
2. Aplica las migraciones con `npx wrangler d1 migrations apply radian-prod --remote` (incluye `0001_sync_records.sql`, `0002_accounts.sql` y `0003_passkey_management.sql`).
3. Configura en Pages Functions los secretos `SESSION_SECRET` y, en producción, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` y `WEBAUTHN_RP_NAME`.
4. Para `radian.nidr0x.win`, usa `WEBAUTHN_RP_ID=radian.nidr0x.win` y `WEBAUTHN_ORIGIN=https://radian.nidr0x.win`.

`SESSION_SECRET` debe ser aleatorio y mantenerse estable entre despliegues. Los retos WebAuthn caducados o consumidos se limpian al solicitar nuevas opciones de registro o acceso. D1 ofrece recuperación automática mediante Time Travel; conviene revisar periódicamente su retención desde Cloudflare antes de publicar cambios destructivos.

La passkey nunca se almacena en Radian: el dispositivo conserva la clave privada y D1 solo guarda la clave pública, el contador de uso y una etiqueta elegida por ti. Desde Perfil puedes añadir, renombrar o revocar dispositivos; siempre debe quedar al menos una passkey activa. El acceso local sigue disponible si no se configura la nube.
