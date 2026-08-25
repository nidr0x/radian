import type { AppData, ExerciseDefinition, ExerciseEquipment, ExerciseGuidance, PlannedExercise, ProgressionPolicy, WorkoutDay } from '../types';

const exercise = (id: string, name: string, muscleGroup: string, equipment: ExerciseEquipment, imageUrl: string, aliases: string[] = []): ExerciseDefinition => ({ id, name, muscleGroup, equipment, aliases, imageUrl, imagePosition: '' });

export const exerciseDefinitions: ExerciseDefinition[] = [
  exercise('incline-press', 'Press inclinado en máquina', 'Pecho', 'machine', '/exercises/individual/incline-press.webp', ['press inclinado']),
  exercise('chest-press', 'Press de pecho', 'Pecho', 'machine', '/exercises/individual/chest-press.webp', ['press horizontal']),
  exercise('cable-fly', 'Aperturas en polea', 'Pecho', 'cable', '/exercises/individual/cable-fly.webp', ['crossover', 'aperturas']),
  exercise('lateral-raise', 'Elevaciones laterales', 'Hombros', 'dumbbell', '/exercises/individual/lateral-raise.webp', ['laterales']),
  exercise('triceps-pushdown', 'Extensión de tríceps en polea', 'Tríceps', 'cable', '/exercises/individual/triceps-pushdown.webp', ['jalón de tríceps']),
  exercise('overhead-triceps', 'Extensión de tríceps sobre la cabeza', 'Tríceps', 'cable', '/exercises/individual/overhead-triceps.webp', ['tríceps por encima de la cabeza']),
  exercise('lat-pulldown', 'Jalón al pecho', 'Espalda', 'machine', '/exercises/individual/lat-pulldown.webp', ['jalón dorsal']),
  exercise('chest-supported-row', 'Remo con apoyo de pecho', 'Espalda', 'machine', '/exercises/individual/chest-supported-row.webp', ['remo en máquina']),
  exercise('straight-arm-pulldown', 'Jalón con brazos rectos', 'Espalda', 'cable', '/exercises/individual/straight-arm-pulldown.webp', ['pullover en polea']),
  exercise('reverse-fly', 'Reverse fly', 'Deltoide posterior', 'machine', '/exercises/individual/reverse-fly.webp', ['pájaros', 'aperturas inversas']),
  exercise('biceps-curl', 'Curl de bíceps', 'Bíceps', 'dumbbell', '/exercises/individual/biceps-curl.webp', ['curl alterno']),
  exercise('incline-curl', 'Curl inclinado', 'Bíceps', 'dumbbell', '/exercises/individual/incline-curl.webp', ['curl con mancuernas']),
  exercise('machine-crunch', 'Crunch abdominal en máquina', 'Abdomen', 'machine', '/exercises/individual/machine-crunch.webp', ['abdominales']),
  exercise('leg-press', 'Prensa', 'Pierna', 'machine', '/exercises/individual/leg-press.webp', ['prensa de piernas']),
  exercise('romanian-deadlift', 'Peso muerto rumano', 'Pierna', 'barbell', '/exercises/individual/romanian-deadlift.webp', ['rumano']),
  exercise('leg-curl', 'Curl femoral', 'Pierna', 'machine', '/exercises/individual/leg-curl.webp', ['femoral']),
  exercise('leg-extension', 'Extensión de cuádriceps', 'Pierna', 'machine', '/exercises/individual/leg-extension.webp', ['extensión de piernas']),
  exercise('calf-raise', 'Gemelos', 'Pierna', 'machine', '/exercises/individual/calf-raise.webp', ['elevación de talones']),
  exercise('shoulder-press', 'Press de hombros', 'Hombros', 'machine', '/exercises/individual/shoulder-press.webp', ['press militar']),
];

export const exerciseGuidance: Record<string, ExerciseGuidance> = {
  'incline-press': { setup: 'Ajusta el asiento para que las asas queden a la altura media del pecho.', cues: ['Apoya la espalda y mantén los pies firmes.', 'Empuja sin bloquear los codos.', 'Baja con control hasta notar el pecho.'], commonMistake: 'Elevar los hombros al empujar.' },
  'chest-press': { setup: 'Coloca las asas alineadas con la mitad del pecho y regula el asiento.', cues: ['Mantén los omóplatos apoyados.', 'Empuja en línea recta.', 'Vuelve lentamente sin perder tensión.'], commonMistake: 'Separar la espalda del respaldo.' },
  'cable-fly': { setup: 'Regula las poleas a la altura del pecho y adelanta un pie para estabilizarte.', cues: ['Mantén una ligera flexión de codos.', 'Cierra los brazos sin encoger los hombros.', 'Regresa con control.'], commonMistake: 'Convertirlo en un press doblando demasiado los codos.' },
  'lateral-raise': { setup: 'Coloca las asas a los lados y ajusta la carga para poder moverlas sin impulso.', cues: ['Eleva hasta la línea de los hombros.', 'Mantén las muñecas neutras.', 'Baja despacio.'], commonMistake: 'Balancear el cuerpo para levantar más peso.' },
  'triceps-pushdown': { setup: 'Ajusta la polea alta y coloca los codos cerca del torso.', cues: ['Empuja desde el codo.', 'Mantén los hombros quietos.', 'Sube hasta notar tensión sin perder postura.'], commonMistake: 'Inclinarse para usar el peso del cuerpo.' },
  'overhead-triceps': { setup: 'Coloca la polea detrás y sitúa el cable por encima de la cabeza.', cues: ['Mantén los codos apuntando al frente.', 'Extiende sin abrirlos.', 'Controla el regreso.'], commonMistake: 'Mover todo el hombro en lugar del codo.' },
  'lat-pulldown': { setup: 'Ajusta el apoyo de las piernas y toma la barra un poco más allá de los hombros.', cues: ['Inicia el movimiento con los codos.', 'Lleva la barra hacia la parte alta del pecho.', 'Evita balancearte.'], commonMistake: 'Tirar de la barra detrás de la nuca.' },
  'chest-supported-row': { setup: 'Ajusta el asiento para apoyar el pecho sin comprimirlo y deja los brazos extendidos.', cues: ['Tira llevando los codos atrás.', 'Mantén el pecho en el apoyo.', 'Pausa un instante al cerrar.'], commonMistake: 'Separar el pecho para ganar recorrido.' },
  'straight-arm-pulldown': { setup: 'Coloca la polea alta y aléjate lo suficiente para mantener los brazos casi rectos.', cues: ['Baja la barra hacia los muslos.', 'Mantén las costillas controladas.', 'Regresa hasta sentir el dorsal.'], commonMistake: 'Doblar los codos y convertirlo en un jalón.' },
  'reverse-fly': { setup: 'Ajusta el asiento para que las asas queden frente a los hombros.', cues: ['Abre con los codos.', 'Mantén el pecho apoyado.', 'Usa un recorrido cómodo.'], commonMistake: 'Lanzar los brazos con impulso.' },
  'biceps-curl': { setup: 'Ajusta el asiento para que el codo quede alineado con el eje de giro.', cues: ['Apoya bien la parte posterior del brazo.', 'Sube sin despegar el codo.', 'Baja por completo con control.'], commonMistake: 'Levantar el hombro para ayudar al bíceps.' },
  'incline-curl': { setup: 'Coloca el respaldo en una inclinación cómoda y deja los brazos colgando sin forzar el hombro.', cues: ['Mantén los codos quietos.', 'Sube sin girar el tronco.', 'Detén el movimiento antes de perder tensión.'], commonMistake: 'Abrir demasiado el codo hacia atrás.' },
  'machine-crunch': { setup: 'Ajusta el asiento para que el eje quede cómodo y coloca el apoyo sobre la parte alta del pecho.', cues: ['Cierra el tronco desde el abdomen.', 'No tires con los brazos.', 'Regresa sin soltar la tensión.'], commonMistake: 'Flexionar la cadera en lugar del tronco.' },
  'leg-press': { setup: 'Coloca los pies a una anchura cómoda y ajusta el respaldo para no despegar la pelvis.', cues: ['Baja hasta donde controles la espalda.', 'Empuja con toda la planta del pie.', 'No bloquees las rodillas.'], commonMistake: 'Dejar que las rodillas se junten al subir.' },
  'romanian-deadlift': { setup: 'Coloca la barra cerca de los muslos y parte con una ligera flexión de rodillas.', cues: ['Lleva la cadera atrás.', 'Mantén la espalda larga.', 'Sube apretando glúteos.'], commonMistake: 'Convertirlo en una sentadilla doblando demasiado las rodillas.' },
  'leg-curl': { setup: 'Alinea la rodilla con el eje de la máquina y coloca el rodillo sobre el tobillo.', cues: ['Flexiona sin despegar la cadera.', 'Aprieta al final del recorrido.', 'Baja despacio.'], commonMistake: 'Levantar la pelvis para completar la repetición.' },
  'leg-extension': { setup: 'Alinea la rodilla con el eje de giro y coloca el rodillo sobre la parte baja de la tibia.', cues: ['Extiende sin dar impulso.', 'Pausa arriba.', 'Baja de forma controlada.'], commonMistake: 'Golpear el tope con la rodilla.' },
  'calf-raise': { setup: 'Apoya la parte delantera del pie y deja el talón libre para moverse.', cues: ['Sube todo lo posible.', 'Pausa arriba.', 'Baja hasta un estiramiento cómodo.'], commonMistake: 'Rebotar para ganar velocidad.' },
  'shoulder-press': { setup: 'Ajusta el asiento para que las asas comiencen ligeramente por debajo de los hombros.', cues: ['Mantén la espalda apoyada.', 'Empuja sin encoger los hombros.', 'Baja hasta un rango cómodo.'], commonMistake: 'Arquear demasiado la zona lumbar.' },
};

const planned = (id: string, exerciseId: string, sets: number, repMin: number, repMax: number, restSeconds: number, warmupSets = 0, progressionPolicy: ProgressionPolicy = 'double'): PlannedExercise => {
  const definition = exerciseDefinitions.find((item) => item.id === exerciseId);
  if (!definition) throw new Error(`Exercise ${exerciseId} not found`);
  return { id, exerciseId, name: definition.name, sets, repMin, repMax, restSeconds, active: true, warmupSets, progressionPolicy, progressionIncrementKg: 2.5, imageUrl: definition.imageUrl, imagePosition: definition.imagePosition };
};

export const initialDays: WorkoutDay[] = [
  {
    id: 'monday', weekday: 1, shortLabel: 'L', name: 'Pecho, hombros, tríceps', focus: 'Pecho y deltoides',
    exercises: [
      planned('mon-1', 'incline-press', 3, 8, 12, 120, 1), planned('mon-2', 'chest-press', 3, 8, 12, 120),
      planned('mon-3', 'cable-fly', 2, 12, 15, 75), planned('mon-4', 'lateral-raise', 3, 12, 20, 75),
      planned('mon-5', 'triceps-pushdown', 3, 10, 15, 75), planned('mon-6', 'overhead-triceps', 2, 10, 15, 75),
    ],
  },
  {
    id: 'tuesday', weekday: 2, shortLabel: 'M', name: 'Espalda, bíceps, abdomen', focus: 'Espalda y brazos',
    exercises: [
      planned('tue-1', 'lat-pulldown', 3, 8, 12, 120, 1), planned('tue-2', 'chest-supported-row', 3, 8, 12, 120),
      planned('tue-3', 'straight-arm-pulldown', 2, 10, 15, 75), planned('tue-4', 'reverse-fly', 2, 12, 20, 75),
      planned('tue-5', 'biceps-curl', 3, 10, 15, 75), planned('tue-6', 'incline-curl', 2, 10, 15, 75),
      planned('tue-7', 'machine-crunch', 3, 10, 15, 60),
    ],
  },
  {
    id: 'wednesday', weekday: 3, shortLabel: 'X', name: 'Piernas, hombros, abdomen', focus: 'Piernas con equilibrio',
    exercises: [
      planned('wed-1', 'leg-press', 3, 8, 12, 150, 1), planned('wed-2', 'romanian-deadlift', 3, 8, 12, 150),
      planned('wed-3', 'leg-curl', 3, 10, 15, 90), planned('wed-4', 'leg-extension', 2, 10, 15, 90),
      planned('wed-5', 'calf-raise', 3, 10, 15, 75), planned('wed-6', 'shoulder-press', 3, 8, 12, 120),
      planned('wed-7', 'machine-crunch', 2, 10, 15, 60),
    ],
  },
  {
    id: 'friday', weekday: 5, shortLabel: 'V', name: 'Torso completo', focus: 'Segundo estímulo del torso',
    exercises: [
      planned('fri-1', 'incline-press', 3, 8, 12, 120), planned('fri-2', 'lat-pulldown', 3, 8, 12, 120),
      planned('fri-3', 'chest-supported-row', 3, 8, 12, 120), planned('fri-4', 'lateral-raise', 3, 12, 20, 75),
      planned('fri-5', 'reverse-fly', 2, 12, 20, 75), planned('fri-6', 'biceps-curl', 2, 10, 15, 75),
      planned('fri-7', 'triceps-pushdown', 2, 10, 15, 75),
    ],
  },
];

export const defaultData = (): AppData => ({
  schemaVersion: 7,
  onboardingComplete: false,
  profile: {
    heightCm: undefined, currentWeightKg: undefined, goal: '', gym: '',
    trainingDays: [1, 2, 3, 5], sessionMinutes: 60, experienceLevel: 'intermediate', largeText: false, theme: 'system',
    nutritionContext: '',
  },
  exercises: exerciseDefinitions,
  plan: { id: 'main-plan', version: 1, days: initialDays },
  sessions: [], progress: [], checkins: [],
});
