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
npm test
npm run build
```

La primera vez, Radian muestra una configuración breve para elegir objetivo, días, duración y nivel. Durante una sesión se puede repetir el registro anterior, saltar un ejercicio, deshacer el último avance y salir conservando la sesión en curso.

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

## Sincronización opcional entre dispositivos

La app sigue funcionando sin backend. Si quieres compartir los datos entre el móvil y el ordenador, el proyecto incluye la Pages Function `/api/sync` y la migración `migrations/0001_sync_records.sql` para Cloudflare D1.

1. Crea una base D1 para la sincronización:

   ```bash
   npx wrangler d1 create fitness-radian-sync
   ```

2. En Cloudflare Pages, añade una vinculación D1 llamada `DB` a los entornos de producción y preview, usando esa base.
3. Aplica la migración en remoto:

   ```bash
   npx wrangler d1 migrations apply fitness-radian-sync --remote
   ```

4. En Radian, abre `Perfil → Sincronizar dispositivos`, genera un código y conecta el primer dispositivo. Introduce el mismo código en el segundo y elige si quieres descargar la copia remota o subir sus datos locales.

El código funciona como llave de acceso a esa copia. El contenido se cifra en el dispositivo antes de subirlo; puedes revocar el código para borrar la copia remota y cortar el acceso de otros dispositivos. No lo compartas. Si ejecutas solo `npm run dev`, la app permanece en modo local-first porque Vite no sirve las Pages Functions.

El despliegue no necesita variables secretas ni una base de datos: Radian guarda los datos en el dispositivo del usuario.

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

La primera versión no cuenta calorías, no registra comidas, no incluye cuentas tradicionales ni proveedor de IA, y usa un código de emparejamiento para la sincronización opcional.
