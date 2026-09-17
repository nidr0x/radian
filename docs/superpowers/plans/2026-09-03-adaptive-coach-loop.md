# Bucle de entrenador adaptativo — Implementation Plan

> **For agentic workers:** This historical plan records the implementation task-by-task. All listed steps are complete.

**Goal:** Añadir histórico útil por ejercicio, un check-in breve de recuperación antes de entrenar y una herramienta MCP que devuelva la próxima sesión accionable.

**Architecture:** Se conserva el enfoque local-first y el formato de datos actual. La recuperación se guarda como un campo opcional de cada `WorkoutSession`, por lo que los datos existentes siguen siendo válidos y no se añade una migración D1. El cálculo de tendencia y la selección de la próxima sesión serán funciones puras reutilizables por la interfaz y el MCP; el MCP solo expondrá lectura.

**Tech Stack:** React, TypeScript, Vite, Vitest, Pages Functions, D1 payload JSON y MCP remoto.

**Spec:** Alcance aprobado en conversación el 2026-09-03: histórico por ejercicio + recuperación + `get_next_session`.
**Estado:** Completado y publicado. Este plan se conserva como registro histórico de la implementación; sus tareas ya no representan trabajo pendiente.

## Global Constraints

- Mantener `schemaVersion: 7`; `readiness` es opcional y debe conservarse al migrar o sincronizar datos antiguos.
- No añadir un proveedor de IA dentro de Radian; el razonamiento sigue en el cliente MCP.
- `get_next_session` es de solo lectura y debe devolver una prescripción explicable mediante `nextPrescription`.
- El check-in debe ser opcional, rápido y no bloquear el inicio de una sesión.
- Los cambios destructivos y los alcances OAuth existentes no se modifican.
- Escribir primero las pruebas de cada comportamiento nuevo y comprobar el fallo antes de implementar.

### Task 1: Modelo de recuperación e histórico por ejercicio

**Files:**
- Modify: `src/types.ts`
- Modify: `src/lib/storage.ts`
- Create: `src/lib/exerciseHistory.ts`
- Test: `tests/domain.test.ts`

**Interfaces:**
- `SessionReadiness = { energy: Energy; soreness: 'none' | 'some' | 'high' }`.
- `WorkoutSession.readiness?: SessionReadiness`.
- `createSession(day, date, now, history, readiness?)` conserva la firma actual y añade el último argumento opcional.
- `exerciseTrend(exerciseId, sessions, limit = 12)` devuelve puntos ordenados de antiguo a reciente con `{ date, maxWeightKg?, maxReps?, volumeKg, difficulty?, discomfort }`.

- [x] **Step 1: Write the failing tests**

Añadir a `tests/domain.test.ts` un test que compruebe que `createSession(..., readiness)` conserva `energy` y `soreness`, y otro que construya dos sesiones con cargas distintas y compruebe que `exerciseTrend` devuelve las dos fechas, el máximo de carga y el volumen de cada sesión.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- --run tests/domain.test.ts`

Expected: FAIL porque `SessionReadiness` y `exerciseTrend` todavía no existen.

- [x] **Step 3: Implement the minimal domain changes**

Añadir los tipos, aceptar `readiness` en `createSession`, conservarlo en `migrateData` mediante la copia existente de la sesión y crear `src/lib/exerciseHistory.ts` filtrando solo sesiones completadas y series de trabajo completadas. El volumen de cada punto será la suma `weightKg * actualReps` de sus series válidas; si no hay carga, el punto conservará volumen `0`.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test -- --run tests/domain.test.ts`

Expected: PASS, incluidos los tests existentes del dominio.

- [x] **Step 5: Commit the task**

```bash
git add src/types.ts src/lib/storage.ts src/lib/exerciseHistory.ts tests/domain.test.ts
git commit -m "feat: add exercise history and session readiness"
```

### Task 2: Herramienta MCP `get_next_session`

**Files:**
- Modify: `functions/lib/mcp.ts`
- Test: `tests/mcp.test.ts`
- Modify: `README.md`

**Interfaces:**
- Añadir `get_next_session` a `MCP_TOOL_DEFINITIONS` sin argumentos.
- `handleMcpTool('get_next_session', {}, loaded)` devuelve `withVersion({ status, date, workoutDayId, workoutName, focus, weekday, exercises }, updatedAt)`.
- Cada ejercicio devuelto incluye `exerciseId`, `name`, `sets`, `repMin`, `repMax`, `restSeconds`, `warmupSets` y `prescription` con `status`, `reason`, `targetReps` y `nextWeightKg` cuando existan.

- [x] **Step 1: Write the failing tests**

Ampliar el test de herramientas de lectura para exigir `get_next_session` y añadir un test de `handleMcpTool` con una sesión histórica fácil que compruebe que la respuesta selecciona un día programado y devuelve una prescripción con `status` y `reason`.

- [x] **Step 2: Run the focused MCP tests and verify RED**

Run: `npm test -- --run tests/mcp.test.ts`

Expected: FAIL porque la herramienta no está listada ni implementada.

- [x] **Step 3: Implement the minimal read-only tool**

Seleccionar el día programado de hoy cuando corresponda; si ya hay una sesión completada hoy, seleccionar el siguiente día programado y, si no queda ninguno, el primero de la semana. Si existe una sesión `in_progress`, devolver `status: 'in_progress'` y sus ejercicios para facilitar la reanudación. Para cada ejercicio activo usar `nextPrescription(exercise, data.sessions)` y no modificar datos.

- [x] **Step 4: Document the MCP capability**

Actualizar la sección del MCP remoto de `README.md` para incluir `get_next_session` entre las consultas disponibles, sin reintroducir ninguna ruta de app personalizada ni copia manual de prompts.

- [x] **Step 5: Run the focused tests and verify GREEN**

Run: `npm test -- --run tests/mcp.test.ts`

Expected: PASS, incluidos permisos read-only y read/write existentes.

- [x] **Step 6: Commit the task**

```bash
git add functions/lib/mcp.ts tests/mcp.test.ts README.md
git commit -m "feat: expose next session through MCP"
```

### Task 3: Interfaz de recuperación y tendencias

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Test: `tests/domain.test.ts`

**Interfaces:**
- `TodayView.onStart` recibe opcionalmente `SessionReadiness`.
- La tarjeta de progreso usa `exerciseTrend` y permite elegir un ejercicio con histórico.

- [x] **Step 1: Write the failing domain assertion**

Añadir un test de `exerciseTrend` que limite a los últimos 12 puntos y ordene por fecha ascendente; este test protege el contrato que consumirá la gráfica.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run tests/domain.test.ts`

Expected: FAIL solo si el contrato de límite u orden todavía no está implementado.

- [x] **Step 3: Add the optional readiness prompt**

Antes de crear la sesión, mostrar una tarjeta pequeña con energía (`Baja`, `Normal`, `Alta`) y molestias musculares (`Ninguna`, `Algo`, `Muchas`), con un botón para empezar sin responder. Pasar la selección a `createSession`; no impedir el entrenamiento ni cambiar la rutina almacenada.

- [x] **Step 4: Add the exercise trend card**

En `Progreso`, mostrar un selector de ejercicios que tengan puntos y una gráfica SVG accesible. Dibujar carga máxima cuando exista; si no hay cargas, dibujar volumen. Mostrar fecha, último valor y una nota clara cuando solo haya un registro.

- [x] **Step 5: Style the new states**

Añadir únicamente los estilos de la tarjeta de recuperación, sus opciones seleccionables y la gráfica, respetando las variables de tema, la densidad móvil y el modo de texto grande.

- [x] **Step 6: Run all local verification**

Run: `npm test -- --run`

Run: `npm run lint`

Run: `npm run lint:functions`

Run: `npm run build`

Run: `git diff --check`

Expected: todos los comandos terminan correctamente y no queda ninguna referencia a la antigua integración ChatGPT web.

- [x] **Step 7: Commit the task**

```bash
git add src/App.tsx src/styles.css tests/domain.test.ts
git commit -m "feat: add readiness and exercise trends"
```

## Release verification

- [x] Confirmar `git status --short` limpio y revisar que los commits solo contienen los paths previstos.
- [x] Ejecutar `node --test mcp/radian-mcp.smoke.mjs` para no romper el MCP local de solo lectura.
- [x] Ejecutar `npm run smoke:prod` solo después de un despliegue explícitamente autorizado.
