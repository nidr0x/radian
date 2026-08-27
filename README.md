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

El repositorio está preparado para usar la integración GitHub de Cloudflare Pages. Configura el proyecto `radian` con:

- Repositorio: `nidr0x/radian`
- Rama de producción: `master`
- Comando de build: `npm ci && npm run build`
- Directorio de salida: `dist`

Pages se encargará de los despliegues de producción y de las previews. GitHub Actions conserva las comprobaciones de TypeScript, Functions, tests y build, pero no necesita credenciales de Cloudflare.

Producción y preview son entornos separados. Producción usa el binding `DB` de `radian-prod`, su propio secreto de sesión y el origin `https://radian.nidr0x.win`. Cada preview debe usar otro D1, otro secreto de sesión y variables WebAuthn derivadas de su hostname; nunca copies los valores de producción a una preview. La configuración de `wrangler.jsonc` deja las variables de preview sin fijar para que la Function valide el hostname de la URL recibida. En el panel de Pages, configura el binding D1 y el secreto por entorno antes de probar autenticación en una preview.

Como alternativa puntual, puedes desplegar la carpeta generada con Wrangler:

```bash
  npm run build
  npx wrangler pages deploy dist --project-name=radian
```

El repositorio incluye un workflow de GitHub Actions. Cada push a `master` y cada pull request ejecutan las comprobaciones, pero la publicación la realiza la integración Git de Cloudflare Pages.

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

2. En Cloudflare Pages, añade una vinculación D1 llamada `DB` a producción y otra vinculación `DB` a preview, usando bases distintas. El despliegue oficial de Radian usa `radian-prod` en producción; la base de preview debe ser independiente.
3. Aplica la migración en remoto:

   ```bash
   npx wrangler d1 migrations apply radian-prod --remote --env production
   ```

4. En Radian, abre `Perfil → Sincronizar dispositivos`, genera un código y conecta el primer dispositivo. Introduce el mismo código en el segundo y elige si quieres descargar la copia remota o subir sus datos locales.

El código funciona como llave de acceso a esa copia. El contenido se cifra en el dispositivo antes de subirlo; puedes revocar el código para borrar la copia remota y cortar el acceso de otros dispositivos. No lo compartas. Si ejecutas solo `npm run dev`, la app permanece en modo local-first porque Vite no sirve las Pages Functions.

El modo local no necesita variables secretas ni una base de datos. Si activas las cuentas passkey, el despliegue necesita la base D1 y los secretos descritos abajo.

Las Functions de autenticación usan `AUTH_RATE_LIMITER` cuando el entorno lo ofrece. Si ese binding no está disponible, aplican un límite por IP y ruta en D1; si tampoco existe D1, responden con error controlado en lugar de aceptar intentos sin límite. Pages dispone además de logs y métricas de Functions desde el panel de Cloudflare.

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
2. Aplica las migraciones con `npx wrangler d1 migrations apply radian-prod --remote --env production` (incluye `0001_sync_records.sql` a `0004_auth_hardening.sql`). Repite el proceso con la base de preview usando el entorno de preview.
3. Configura en Pages Functions los secretos `SESSION_SECRET` y, en producción, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` y `WEBAUTHN_RP_NAME`.
4. Para `radian.nidr0x.win`, usa `WEBAUTHN_RP_ID=radian.nidr0x.win` y `WEBAUTHN_ORIGIN=https://radian.nidr0x.win`.

`SESSION_SECRET` debe ser aleatorio y mantenerse estable entre despliegues. Los retos WebAuthn caducados o consumidos, los límites antiguos y las sesiones expiradas se limpian al solicitar nuevas opciones. Las sesiones son opacas, revocables y quedan vinculadas a la versión de sesión del usuario. Añadir, renombrar o revocar una passkey exige una verificación reciente con otra passkey; revocar una passkey invalida las sesiones que se crearon con ella. D1 ofrece recuperación automática mediante Time Travel; conviene revisar periódicamente su retención desde Cloudflare antes de publicar cambios destructivos.

La passkey nunca se almacena en Radian: el dispositivo conserva la clave privada y D1 solo guarda la clave pública, el contador de uso y una etiqueta elegida por ti. Desde Perfil puedes añadir, renombrar o revocar dispositivos; siempre debe quedar al menos una passkey activa. El acceso local sigue disponible si no se configura la nube.

## Validación en móvil

Haz estas comprobaciones después de publicar una versión en el entorno correspondiente, usando siempre su hostname HTTPS:

- En iPhone con Safari: crea una cuenta con Face ID, cierra sesión, vuelve a entrar, añade una passkey desde otro dispositivo y confirma que la nueva etiqueta aparece en Perfil.
- En Android con Chrome: repite el alta usando huella, PIN o el gestor de credenciales, cierra sesión y valida el acceso desde el mismo dispositivo.
- En Perfil: renombra una passkey y revócala después de la verificación adicional; comprueba que una sesión creada con la passkey revocada deja de ser válida y que la última passkey no se puede borrar.
- Abre la cuenta en dos navegadores, usa `Cerrar en todos` y confirma que el segundo navegador vuelve a pedir autenticación.
- Empareja dos dispositivos con el código de sincronización, comprueba que el contenido remoto no se puede leer con un código incorrecto y provoca una edición simultánea para verificar el conflicto.
- En una preview, confirma que la Function usa su origin WebAuthn, su D1 y su secreto propios, y que nunca muestra datos de producción.
