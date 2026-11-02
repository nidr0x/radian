// Static, original starter programs. Program descriptions have Spanish and English text; routine
// names stay canonical English once copied into a user's plan.
import { CATALOGUE } from './exercises.js'

const lift = (id, sets, repsMin, reps, restSec, prog) => ({
  id, sets, repsMin, reps, restSec, prog, mode: 'reps'
})
const session = (day, name, nameEs, emoji, exercises) => ({ day, name, nameEs, emoji, exercises })
const program = (id, name, nameEs, about, aboutEs, goal, level, equipment, sessions) => ({
  id, name, nameEs, about, aboutEs, goal, level, equipment, sessions
})

// Each entry carries its complete saved prescription. No exercise here is time-based.
const X = {
  squat5: lift('0043', 4, 4, 6, 180, 'double'), squat6: lift('0043', 5, 3, 5, 210, 'double'),
  frontSquat: lift('1436', 4, 5, 7, 180, 'double'), smithSquat: lift('1434', 3, 6, 10, 150, 'double'),
  dbSquat: lift('1760', 3, 8, 12, 120, 'double'), goblet: lift('0534', 3, 8, 12, 120, 'double'),
  deadlift: lift('0032', 3, 3, 5, 210, 'double'), deadliftHy: lift('0032', 3, 5, 8, 180, 'double'),
  rdl: lift('0085', 3, 6, 10, 150, 'double'), dbRdl: lift('0432', 3, 8, 12, 120, 'double'),
  legPress: lift('0739', 3, 8, 12, 120, 'double'), machinePress: lift('2267', 3, 8, 12, 120, 'double'),
  legExt: lift('0585', 3, 10, 15, 75, 'double'), legCurl: lift('0586', 3, 10, 15, 75, 'double'),
  seatedCurl: lift('0599', 3, 8, 12, 90, 'double'), calf: lift('0605', 3, 10, 15, 60, 'double'),
  dbCalf: lift('0417', 3, 12, 18, 60, 'double'), hipThrust: lift('1060', 3, 8, 12, 120, 'double'),
  dbHip: lift('4742', 3, 10, 15, 90, 'double'), lunge: lift('0054', 3, 6, 10, 120, 'double'),
  dbLunge: lift('0336', 3, 8, 12, 90, 'double'), stepUp: lift('0114', 3, 8, 12, 90, 'double'),
  bench5: lift('0025', 4, 4, 6, 180, 'double'), bench6: lift('0025', 5, 3, 5, 210, 'double'),
  benchHy: lift('0025', 4, 6, 10, 150, 'double'), incline: lift('0047', 3, 6, 10, 120, 'double'),
  dbBench: lift('0289', 3, 8, 12, 90, 'double'), dbIncline: lift('0314', 3, 8, 12, 90, 'double'),
  closeBench: lift('0030', 3, 5, 8, 150, 'double'), machineChest: lift('0576', 3, 8, 12, 90, 'double'),
  cableChest: lift('2144', 3, 8, 12, 90, 'double'), bandChest: lift('1254', 3, 10, 15, 75, 'double'),
  inclinePush: lift('0493', 3, 8, 15, 75, 'double'), declinePush: lift('0279', 3, 6, 12, 90, 'double'),
  dip: lift('0251', 3, 6, 12, 90, 'double'),
  ohp: lift('0091', 3, 5, 8, 150, 'double'), dbOhp: lift('0426', 3, 6, 10, 120, 'double'),
  machineOhp: lift('0587', 3, 8, 12, 90, 'double'), bandOhp: lift('0997', 3, 10, 15, 75, 'double'),
  lateral: lift('0334', 3, 12, 18, 60, 'double'), dbArnold: lift('2137', 3, 8, 12, 90, 'double'),
  row5: lift('0027', 4, 5, 8, 150, 'double'), rowHy: lift('0027', 4, 8, 12, 120, 'double'),
  dbRow: lift('0293', 3, 8, 12, 90, 'double'), supportedRow: lift('5661', 3, 8, 12, 90, 'double'),
  cableRow: lift('1323', 3, 8, 12, 90, 'double'), cableRow2: lift('0861', 3, 10, 15, 75, 'double'),
  machineRow: lift('1350', 3, 8, 12, 90, 'double'), bandRow: lift('3899', 3, 10, 15, 75, 'double'),
  pulldown: lift('2330', 4, 6, 10, 120, 'double'), pulldown2: lift('0150', 3, 8, 12, 90, 'double'),
  chin: lift('1326', 3, 5, 10, 120, 'double'), invertedRow: lift('0499', 3, 6, 12, 90, 'double'),
  bandPull: lift('3326', 3, 10, 15, 75, 'double'),
  biceps: lift('0031', 3, 8, 12, 75, 'double'), dbCurl: lift('0285', 3, 8, 12, 75, 'double'),
  hammer: lift('0313', 3, 10, 15, 60, 'double'), cableCurl: lift('0868', 3, 10, 15, 60, 'double'),
  bandCurl: lift('4063', 3, 10, 15, 60, 'double'), preacher: lift('0592', 3, 8, 12, 75, 'double'),
  pushdown: lift('0241', 3, 8, 12, 75, 'double'), dbTri: lift('0430', 3, 8, 12, 75, 'double'),
  closePush: lift('0283', 3, 6, 12, 75, 'double'), bandTri: lift('1502', 3, 10, 15, 60, 'double'),
  cableFly: lift('0227', 3, 10, 15, 60, 'double'), dbFly: lift('0319', 3, 10, 15, 60, 'double'),
  bandFly: lift('4075', 3, 12, 18, 60, 'double'), facePull: lift('5607', 3, 12, 18, 60, 'double'),
  rearDelt: lift('0378', 3, 12, 18, 60, 'double'), bandRear: lift('4682', 3, 12, 18, 60, 'double'),
  crunch: lift('0175', 3, 10, 15, 60, 'double'), deadBug: lift('1243', 3, 8, 12, 45, 'double'),
  birdDog: lift('1241', 3, 8, 12, 45, 'double'), plankRow: lift('10185', 3, 8, 12, 60, 'double'),
  bodyLunge: lift('1460', 3, 8, 15, 60, 'double'), bodySquat: lift('1476', 3, 6, 10, 75, 'double'),
  bandSquat: lift('1004', 3, 10, 15, 75, 'double'), bandRdl: lift('1009', 3, 10, 15, 75, 'double'),
  bandCurlLeg: lift('0911', 3, 10, 15, 60, 'double'), bandLegExt: lift('3518', 3, 10, 15, 60, 'double'),
  bandCalf: lift('0894', 3, 12, 18, 45, 'double'), bandLunge: lift('0909', 3, 8, 12, 60, 'double'),
  bandPress: lift('3780', 3, 10, 15, 75, 'double'), bandLat: lift('0907', 3, 12, 18, 45, 'double'),
  kbSquat: lift('0534', 4, 6, 10, 120, 'double'), kbDead: lift('3322', 3, 8, 12, 120, 'double'),
  kbPress: lift('0520', 3, 6, 10, 120, 'double'), kbRow: lift('0541', 3, 8, 12, 90, 'double'),
  kbSwing: lift('1568', 4, 10, 15, 90, 'double'), kbLunge: lift('3575', 3, 8, 12, 90, 'double')
}

const D = (day, name, nameEs, emoji, exercises) => session(day, name, nameEs, emoji, exercises)
const CATALOG = [
  // The four existing choices remain available, now with full, explicit prescriptions.
  program('ppl', 'Push / Pull / Legs', 'Empuje / Tirón / Piernas', 'Three focused sessions split by movement group.', 'Tres sesiones centradas en cada grupo de movimientos.', 'hypertrophy', 'intermediate', ['gym'], [
    D(1, 'Push Day', 'Empuje', 'barbell', [X.benchHy, X.incline, X.dbOhp, X.lateral, X.pushdown, X.dip]),
    D(3, 'Pull Day', 'Tirón', 'pullup', [X.pulldown, X.rowHy, X.cableRow, X.biceps, X.hammer]),
    D(5, 'Leg Day', 'Piernas', 'legs', [X.squat5, X.rdl, X.legPress, X.legExt, X.legCurl, X.calf])
  ]),
  program('upper-lower', 'Upper / Lower', 'Tren superior / inferior', 'Four balanced upper- and lower-body sessions.', 'Cuatro sesiones equilibradas de tren superior e inferior.', 'hypertrophy', 'intermediate', ['gym'], [
    D(1, 'Upper A', 'Superior A', 'barbell', [X.benchHy, X.pulldown, X.dbOhp, X.cableRow, X.pushdown, X.biceps]),
    D(2, 'Lower A', 'Inferior A', 'legs', [X.squat5, X.rdl, X.legExt, X.legCurl, X.calf]),
    D(4, 'Upper B', 'Superior B', 'barbell', [X.incline, X.rowHy, X.machineOhp, X.pulldown2, X.lateral, X.hammer]),
    D(5, 'Lower B', 'Inferior B', 'legs', [X.legPress, X.hipThrust, X.seatedCurl, X.dbLunge, X.calf])
  ]),
  program('full-body', 'Full Body', 'Cuerpo completo', 'Three full-body sessions with different main lifts.', 'Tres sesiones de cuerpo completo con ejercicios principales distintos.', 'general', 'beginner', ['gym'], [
    D(1, 'Full Body A', 'Cuerpo completo A', 'figureStrength', [X.squat5, X.benchHy, X.pulldown, X.legCurl, X.lateral]),
    D(3, 'Full Body B', 'Cuerpo completo B', 'figureStrength', [X.rdl, X.incline, X.cableRow, X.legExt, X.pushdown]),
    D(5, 'Full Body C', 'Cuerpo completo C', 'figureStrength', [X.legPress, X.dbBench, X.rowHy, X.dbOhp, X.hammer])
  ]),
  program('5x5', '5×5', '5×5', 'Three alternating sessions built around five sets of five.', 'Tres sesiones alternas centradas en cinco series de cinco.', 'strength', 'beginner', ['gym'], [
    D(1, '5×5 A', '5×5 A', 'barbell', [lift('0043', 5, 5, 5, 180, 'linear'), lift('0025', 5, 5, 5, 180, 'linear'), lift('0027', 5, 5, 5, 150, 'linear')]),
    D(3, '5×5 B', '5×5 B', 'barbell', [lift('0085', 5, 5, 5, 180, 'linear'), lift('0091', 5, 5, 5, 150, 'linear'), lift('2330', 5, 5, 5, 120, 'linear')]),
    D(5, '5×5 C', '5×5 C', 'barbell', [lift('0739', 5, 5, 5, 150, 'linear'), lift('0047', 5, 5, 5, 150, 'linear'), lift('1323', 5, 5, 5, 120, 'linear')])
  ]),

  // 56 original programs, composed from the app's exercise IDs rather than copied routines.
  program('foundation-full-body-3', 'Foundation Full Body', 'Cuerpo completo base', 'Three manageable gym sessions for building a repeatable habit.', 'Tres sesiones asequibles de gimnasio para crear una rutina constante.', 'general', 'beginner', ['gym'], [
    D(1, 'Foundation A', 'Base A', 'figureStrength', [X.squat5, X.benchHy, X.rowHy, X.deadBug]),
    D(3, 'Foundation B', 'Base B', 'figureStrength', [X.rdl, X.dbOhp, X.pulldown, X.birdDog]),
    D(5, 'Foundation C', 'Base C', 'figureStrength', [X.legPress, X.incline, X.cableRow, X.calf])
  ]),
  program('dumbbell-full-body-3', 'Dumbbell Full Body', 'Cuerpo completo con mancuernas', 'Three sessions using a bench and dumbbells.', 'Tres sesiones con banco y mancuernas.', 'general', 'beginner', ['dumbbells'], [
    D(1, 'Dumbbell A', 'Mancuernas A', 'dumbbell', [X.goblet, X.dbBench, X.dbRow, X.dbHip]),
    D(3, 'Dumbbell B', 'Mancuernas B', 'dumbbell', [X.dbRdl, X.dbOhp, X.invertedRow, X.dbCurl]),
    D(5, 'Dumbbell C', 'Mancuernas C', 'dumbbell', [X.dbLunge, X.dbIncline, X.supportedRow, X.dbCalf])
  ]),
  program('band-full-body-3', 'Resistance Band Full Body', 'Cuerpo completo con bandas', 'Three home sessions built around resistance bands.', 'Tres sesiones en casa con bandas de resistencia.', 'general', 'beginner', ['bands'], [
    D(1, 'Band A', 'Bandas A', 'dumbbell', [X.bandSquat, X.bandChest, X.bandRow, X.bandCurlLeg]),
    D(3, 'Band B', 'Bandas B', 'dumbbell', [X.bandRdl, X.bandOhp, X.bandPull, X.bandLegExt]),
    D(5, 'Band C', 'Bandas C', 'dumbbell', [X.bandLunge, X.bandPress, X.bandRow, X.bandCalf])
  ]),
  program('bodyweight-full-body-3', 'Bodyweight Basics', 'Básicos con peso corporal', 'Three sessions using bodyweight movements and a sturdy row anchor.', 'Tres sesiones con peso corporal y un apoyo estable para los remos.', 'general', 'beginner', ['bodyweight'], [
    D(1, 'Bodyweight A', 'Peso corporal A', 'figureStrength', [X.bodySquat, X.inclinePush, X.invertedRow, X.deadBug]),
    D(3, 'Bodyweight B', 'Peso corporal B', 'figureStrength', [X.bodyLunge, X.declinePush, X.birdDog, X.bodySquat]),
    D(5, 'Bodyweight C', 'Peso corporal C', 'figureStrength', [X.bodySquat, X.invertedRow, X.closePush, X.crunch])
  ]),
  program('upper-lower-3', 'Upper / Lower Three-Day', 'Superior / inferior en tres días', 'An upper-lower rotation with a second upper session each week.', 'Alterna tren superior e inferior con una segunda sesión superior.', 'general', 'beginner', ['gym'], [
    D(1, 'Upper A', 'Superior A', 'barbell', [X.benchHy, X.pulldown2, X.dbOhp, X.biceps]),
    D(3, 'Lower', 'Inferior', 'legs', [X.squat5, X.rdl, X.legCurl, X.calf]),
    D(5, 'Upper B', 'Superior B', 'barbell', [X.incline, X.cableRow, X.machineOhp, X.pushdown])
  ]),
  program('upper-lower-hypertrophy-4', 'Upper / Lower Volume', 'Volumen superior / inferior', 'Four sessions with moderate volume and two exposures per body region.', 'Cuatro sesiones de volumen moderado y dos estímulos por zona.', 'hypertrophy', 'intermediate', ['gym'], [
    D(1, 'Upper A', 'Superior A', 'barbell', [X.benchHy, X.pulldown, X.dbOhp, X.cableRow, X.lateral, X.pushdown]),
    D(2, 'Lower A', 'Inferior A', 'legs', [X.squat5, X.hipThrust, X.legExt, X.seatedCurl, X.calf]),
    D(4, 'Upper B', 'Superior B', 'barbell', [X.dbIncline, X.rowHy, X.machineOhp, X.pulldown2, X.dbCurl, X.facePull]),
    D(5, 'Lower B', 'Inferior B', 'legs', [X.legPress, X.rdl, X.dbLunge, X.legCurl, X.dbCalf])
  ]),
  program('upper-lower-5', 'Upper / Lower Five-Day', 'Superior / inferior en cinco días', 'A five-day split with a shorter arm and shoulder session.', 'División de cinco días con una sesión breve de brazos y hombros.', 'hypertrophy', 'intermediate', ['gym'], [
    D(1, 'Upper A', 'Superior A', 'barbell', [X.benchHy, X.rowHy, X.dbOhp, X.lateral]),
    D(2, 'Lower A', 'Inferior A', 'legs', [X.squat5, X.rdl, X.legCurl, X.calf]),
    D(3, 'Arms & Shoulders', 'Brazos y hombros', 'figureStrength', [X.closeBench, X.preacher, X.dbTri, X.rearDelt]),
    D(5, 'Upper B', 'Superior B', 'barbell', [X.incline, X.pulldown, X.cableRow, X.dbCurl]),
    D(6, 'Lower B', 'Inferior B', 'legs', [X.legPress, X.hipThrust, X.legExt, X.seatedCurl])
  ]),
  program('upper-lower-6', 'Upper / Lower Six-Day', 'Superior / inferior en seis días', 'Six shorter sessions alternating upper and lower body.', 'Seis sesiones cortas alternando tren superior e inferior.', 'hypertrophy', 'advanced', ['gym'], [
    D(1, 'Upper A', 'Superior A', 'barbell', [X.benchHy, X.pulldown, X.lateral, X.pushdown]),
    D(2, 'Lower A', 'Inferior A', 'legs', [X.squat5, X.legCurl, X.calf]),
    D(3, 'Upper B', 'Superior B', 'barbell', [X.incline, X.rowHy, X.dbOhp, X.biceps]),
    D(4, 'Lower B', 'Inferior B', 'legs', [X.rdl, X.legPress, X.legExt]),
    D(5, 'Upper C', 'Superior C', 'barbell', [X.dbBench, X.machineRow, X.machineOhp, X.hammer]),
    D(6, 'Lower C', 'Inferior C', 'legs', [X.hipThrust, X.dbLunge, X.seatedCurl, X.dbCalf])
  ]),
  program('ppl-3', 'Push / Pull / Legs Three-Day', 'Empuje / tirón / piernas en tres días', 'One focused push, pull and leg session each week.', 'Una sesión semanal centrada en empuje, tirón y piernas.', 'hypertrophy', 'beginner', ['gym'], [
    D(1, 'Push', 'Empuje', 'barbell', [X.benchHy, X.dbOhp, X.lateral, X.pushdown]),
    D(3, 'Pull', 'Tirón', 'pullup', [X.pulldown, X.rowHy, X.dbCurl, X.facePull]),
    D(5, 'Legs', 'Piernas', 'legs', [X.squat5, X.rdl, X.legPress, X.calf])
  ]),
  program('ppl-6', 'Push / Pull / Legs Six-Day', 'Empuje / tirón / piernas en seis días', 'A higher-frequency split with a second variation of each session.', 'División de mayor frecuencia con una segunda variante de cada sesión.', 'hypertrophy', 'advanced', ['gym'], [
    D(1, 'Push A', 'Empuje A', 'barbell', [X.benchHy, X.incline, X.dbOhp, X.pushdown]),
    D(2, 'Pull A', 'Tirón A', 'pullup', [X.pulldown, X.rowHy, X.biceps, X.rearDelt]),
    D(3, 'Legs A', 'Piernas A', 'legs', [X.squat5, X.rdl, X.legExt, X.calf]),
    D(4, 'Push B', 'Empuje B', 'barbell', [X.dbBench, X.machineOhp, X.lateral, X.dip]),
    D(5, 'Pull B', 'Tirón B', 'pullup', [X.cableRow, X.pulldown2, X.hammer, X.facePull]),
    D(6, 'Legs B', 'Piernas B', 'legs', [X.legPress, X.hipThrust, X.seatedCurl, X.dbCalf])
  ]),
  program('ppl-5', 'Push / Pull / Legs Five-Day', 'Empuje / tirón / piernas en cinco días', 'A five-day push-pull-legs schedule with a lighter upper finish.', 'Cinco días de empuje, tirón y piernas con un cierre superior más ligero.', 'hypertrophy', 'intermediate', ['gym'], [
    D(1, 'Push', 'Empuje', 'barbell', [X.benchHy, X.incline, X.lateral, X.pushdown]),
    D(2, 'Pull', 'Tirón', 'pullup', [X.pulldown, X.rowHy, X.biceps, X.hammer]),
    D(3, 'Legs', 'Piernas', 'legs', [X.squat5, X.rdl, X.legCurl, X.calf]),
    D(5, 'Upper', 'Superior', 'barbell', [X.dbBench, X.cableRow, X.dbOhp, X.facePull]),
    D(6, 'Lower', 'Inferior', 'legs', [X.legPress, X.hipThrust, X.legExt, X.dbLunge])
  ]),
  program('torso-limbs-4', 'Torso / Limbs', 'Torso / extremidades', 'Four sessions separate torso work from arms and legs.', 'Cuatro sesiones que separan torso, brazos y piernas.', 'hypertrophy', 'intermediate', ['gym'], [
    D(1, 'Torso A', 'Torso A', 'barbell', [X.benchHy, X.rowHy, X.pulldown2, X.dbOhp, X.facePull]),
    D(2, 'Limbs A', 'Extremidades A', 'figureStrength', [X.squat5, X.dbLunge, X.biceps, X.pushdown, X.calf]),
    D(4, 'Torso B', 'Torso B', 'barbell', [X.incline, X.cableRow, X.machineOhp, X.dbFly, X.rearDelt]),
    D(5, 'Limbs B', 'Extremidades B', 'figureStrength', [X.rdl, X.legPress, X.hipThrust, X.hammer, X.dbTri])
  ]),
  program('novice-5x5', 'Novice Barbell 5×5', '5×5 de iniciación con barra', 'Three alternating barbell days with a small lift menu.', 'Tres días alternos con barra y pocos ejercicios.', 'strength', 'beginner', ['gym'], [
    D(1, 'Workout A', 'Sesión A', 'barbell', [lift('1436', 3, 5, 5, 180, 'linear'), lift('0025', 3, 5, 5, 180, 'linear'), lift('0027', 3, 8, 8, 120, 'linear')]),
    D(3, 'Workout B', 'Sesión B', 'barbell', [lift('0085', 3, 6, 6, 150, 'linear'), lift('0091', 3, 5, 5, 150, 'linear'), lift('1326', 3, 5, 8, 120, 'double')]),
    D(5, 'Workout A2', 'Sesión A2', 'barbell', [lift('0043', 3, 5, 5, 180, 'linear'), lift('0047', 3, 6, 6, 150, 'linear'), lift('2330', 3, 8, 8, 120, 'linear')])
  ]),
  program('barbell-strength-4', 'Four-Day Barbell Strength', 'Fuerza con barra en cuatro días', 'Upper-lower strength practice with accessory work kept brief.', 'Práctica de fuerza superior-inferior con pocos accesorios.', 'strength', 'intermediate', ['gym'], [
    D(1, 'Upper A', 'Superior A', 'barbell', [X.bench5, X.row5, X.ohp, X.closeBench]),
    D(2, 'Lower A', 'Inferior A', 'legs', [X.squat6, X.rdl, X.calf]),
    D(4, 'Upper B', 'Superior B', 'barbell', [X.incline, X.pulldown, X.closeBench, X.biceps]),
    D(5, 'Lower B', 'Inferior B', 'legs', [X.deadlift, X.frontSquat, X.legCurl])
  ]),
  program('powerbuilding-4', 'Powerbuilding Four-Day', 'Fuerza e hipertrofia en cuatro días', 'Two strength-led sessions and two moderate-volume sessions.', 'Dos sesiones centradas en fuerza y dos de volumen moderado.', 'strength', 'intermediate', ['gym'], [
    D(1, 'Upper Strength', 'Superior fuerza', 'barbell', [X.bench6, X.row5, X.ohp, X.closeBench]),
    D(2, 'Lower Strength', 'Inferior fuerza', 'legs', [X.squat6, X.deadlift, X.calf]),
    D(4, 'Upper Volume', 'Superior volumen', 'barbell', [X.dbIncline, X.cableRow, X.dbOhp, X.cableFly, X.hammer]),
    D(5, 'Lower Volume', 'Inferior volumen', 'legs', [X.legPress, X.hipThrust, X.seatedCurl, X.dbLunge])
  ]),
  program('powerbuilding-5', 'Powerbuilding Five-Day', 'Fuerza e hipertrofia en cinco días', 'A main barbell lift leads each day before supporting work.', 'Un levantamiento principal con barra abre cada día.', 'strength', 'advanced', ['gym'], [
    D(1, 'Bench Focus', 'Prioridad banca', 'barbell', [X.bench6, X.dbIncline, X.rowHy, X.pushdown]),
    D(2, 'Squat Focus', 'Prioridad sentadilla', 'legs', [X.squat6, X.rdl, X.legExt]),
    D(3, 'Back & Shoulders', 'Espalda y hombros', 'pullup', [X.pulldown, X.ohp, X.cableRow, X.lateral]),
    D(5, 'Deadlift Focus', 'Prioridad peso muerto', 'barbell', [X.deadlift, X.frontSquat, X.seatedCurl]),
    D(6, 'Arms & Chest', 'Brazos y pecho', 'figureStrength', [X.closeBench, X.incline, X.preacher, X.dbTri])
  ]),
  program('squat-focus-3', 'Squat-Focused Strength', 'Fuerza con prioridad de sentadilla', 'Three days with two squat exposures and one hinge emphasis.', 'Tres días con dos estímulos de sentadilla y uno de bisagra.', 'strength', 'intermediate', ['gym'], [
    D(1, 'Squat A', 'Sentadilla A', 'legs', [X.squat6, X.benchHy, X.row5, X.calf]),
    D(3, 'Hinge', 'Bisagra', 'barbell', [X.deadliftHy, X.incline, X.pulldown, X.legCurl]),
    D(5, 'Squat B', 'Sentadilla B', 'legs', [X.frontSquat, X.closeBench, X.cableRow, X.legPress])
  ]),
  program('bench-focus-3', 'Bench-Focused Strength', 'Fuerza con prioridad de banca', 'Three sessions with varied pressing and balanced pulling.', 'Tres sesiones con variantes de empuje y tirón equilibrado.', 'strength', 'intermediate', ['gym'], [
    D(1, 'Bench A', 'Banca A', 'barbell', [X.bench6, X.row5, X.squat5, X.pushdown]),
    D(3, 'Bench B', 'Banca B', 'barbell', [X.closeBench, X.pulldown, X.rdl, X.dbOhp]),
    D(5, 'Bench C', 'Banca C', 'barbell', [X.incline, X.cableRow, X.legPress, X.biceps])
  ]),
  program('deadlift-focus-3', 'Deadlift-Focused Strength', 'Fuerza con prioridad de peso muerto', 'A low-frequency strength split with two hinge variations.', 'División de fuerza con dos variantes de bisagra semanal.', 'strength', 'intermediate', ['gym'], [
    D(1, 'Deadlift A', 'Peso muerto A', 'barbell', [X.deadlift, X.benchHy, X.pulldown, X.calf]),
    D(3, 'Upper', 'Superior', 'figureStrength', [X.ohp, X.row5, X.closeBench, X.biceps]),
    D(5, 'Deadlift B', 'Peso muerto B', 'barbell', [X.rdl, X.squat5, X.incline, X.legCurl])
  ]),
  program('gym-minimalist-2', 'Minimalist Gym Strength', 'Fuerza minimalista en gimnasio', 'Two full-body days built from compound lifts.', 'Dos días de cuerpo completo con movimientos compuestos.', 'strength', 'beginner', ['gym'], [
    D(1, 'Day A', 'Día A', 'barbell', [X.squat5, X.bench5, X.row5, X.deadBug]),
    D(4, 'Day B', 'Día B', 'barbell', [X.rdl, X.ohp, X.pulldown, X.lunge])
  ]),
  program('machine-hypertrophy-4', 'Machine Hypertrophy', 'Hipertrofia con máquinas', 'Four sessions using guided machines and cable stations.', 'Cuatro sesiones con máquinas guiadas y poleas.', 'hypertrophy', 'beginner', ['machines'], [
    D(1, 'Upper A', 'Superior A', 'machine', [X.machineChest, X.machineRow, X.machineOhp, X.pushdown]),
    D(2, 'Lower A', 'Inferior A', 'machine', [X.machinePress, X.legExt, X.seatedCurl, X.calf]),
    D(4, 'Upper B', 'Superior B', 'machine', [X.incline, X.pulldown2, X.cableRow2, X.preacher]),
    D(5, 'Lower B', 'Inferior B', 'machine', [X.hipThrust, X.legPress, X.legCurl, X.dbCalf])
  ]),
  program('machine-full-body-3', 'Machine Full Body', 'Cuerpo completo con máquinas', 'Three simple sessions across the main machine stations.', 'Tres sesiones sencillas con las principales máquinas.', 'general', 'beginner', ['machines'], [
    D(1, 'Machine A', 'Máquinas A', 'machine', [X.machinePress, X.machineChest, X.machineRow, X.crunch]),
    D(3, 'Machine B', 'Máquinas B', 'machine', [X.legPress, X.pulldown2, X.machineOhp, X.legCurl]),
    D(5, 'Machine C', 'Máquinas C', 'machine', [X.legExt, X.cableChest, X.cableRow2, X.calf])
  ]),
  program('dumbbell-upper-lower-4', 'Dumbbell Upper / Lower', 'Superior / inferior con mancuernas', 'Four sessions with a bench, dumbbells and simple progressions.', 'Cuatro sesiones con banco, mancuernas y progresión sencilla.', 'hypertrophy', 'beginner', ['dumbbells'], [
    D(1, 'Upper A', 'Superior A', 'dumbbell', [X.dbBench, X.dbRow, X.dbOhp, X.dbCurl]),
    D(2, 'Lower A', 'Inferior A', 'dumbbell', [X.dbSquat, X.dbRdl, X.dbLunge, X.dbCalf]),
    D(4, 'Upper B', 'Superior B', 'dumbbell', [X.dbIncline, X.supportedRow, X.dbArnold, X.dbTri]),
    D(5, 'Lower B', 'Inferior B', 'dumbbell', [X.goblet, X.dbHip, X.stepUp, X.dbCalf])
  ]),
  program('dumbbell-strength-3', 'Dumbbell Strength', 'Fuerza con mancuernas', 'Three days with heavier compound dumbbell movements.', 'Tres días con movimientos compuestos de mancuerna.', 'strength', 'intermediate', ['dumbbells'], [
    D(1, 'Workout A', 'Sesión A', 'dumbbell', [X.dbSquat, X.dbBench, X.dbRow, X.dbCurl]),
    D(3, 'Workout B', 'Sesión B', 'dumbbell', [X.dbRdl, X.dbOhp, X.invertedRow, X.closePush]),
    D(5, 'Workout C', 'Sesión C', 'dumbbell', [X.dbLunge, X.dbIncline, X.supportedRow, X.dbTri])
  ]),
  program('dumbbell-four-day-mix', 'Dumbbell Four-Day Mix', 'Mancuernas en cuatro días', 'Four compact sessions split between push, pull and legs.', 'Cuatro sesiones compactas de empuje, tirón y piernas.', 'general', 'intermediate', ['dumbbells'], [
    D(1, 'Push A', 'Empuje A', 'dumbbell', [X.dbBench, X.dbOhp, X.lateral, X.dbTri]),
    D(2, 'Pull A', 'Tirón A', 'dumbbell', [X.dbRow, X.supportedRow, X.dbCurl, X.rearDelt]),
    D(4, 'Legs A', 'Piernas A', 'dumbbell', [X.dbSquat, X.dbRdl, X.dbLunge, X.dbCalf]),
    D(5, 'Full Body B', 'Cuerpo completo B', 'dumbbell', [X.dbIncline, X.invertedRow, X.dbHip, X.stepUp])
  ]),
  program('band-home-2', 'Two-Day Band Training', 'Bandas en dos días', 'Two home sessions with a full-body balance.', 'Dos sesiones en casa equilibradas para todo el cuerpo.', 'general', 'beginner', ['bands'], [
    D(1, 'Day A', 'Día A', 'dumbbell', [X.bandSquat, X.bandChest, X.bandRow, X.bandCurl]),
    D(4, 'Day B', 'Día B', 'dumbbell', [X.bandRdl, X.bandOhp, X.bandLunge, X.bandTri])
  ]),
  program('band-home-4', 'Four-Day Band Split', 'Bandas en cuatro días', 'Short upper- and lower-body band sessions at home.', 'Sesiones cortas de tren superior e inferior en casa.', 'hypertrophy', 'beginner', ['bands'], [
    D(1, 'Upper A', 'Superior A', 'dumbbell', [X.bandChest, X.bandRow, X.bandOhp, X.bandCurl]),
    D(2, 'Lower A', 'Inferior A', 'legs', [X.bandSquat, X.bandRdl, X.bandCurlLeg, X.bandCalf]),
    D(4, 'Upper B', 'Superior B', 'dumbbell', [X.bandPress, X.bandPull, X.bandRear, X.bandTri]),
    D(5, 'Lower B', 'Inferior B', 'legs', [X.bandLunge, X.bandLegExt, X.bandCurlLeg, X.bandCalf])
  ]),
  program('calisthenics-foundation-3', 'Calisthenics Foundation', 'Calistenia base', 'Three sessions with scalable bodyweight pushes, pulls and legs.', 'Tres sesiones escalables de empuje, tirón y piernas con peso corporal.', 'general', 'beginner', ['bodyweight'], [
    D(1, 'Calisthenics A', 'Calistenia A', 'figureStrength', [X.inclinePush, X.invertedRow, X.bodySquat, X.deadBug]),
    D(3, 'Calisthenics B', 'Calistenia B', 'figureStrength', [X.declinePush, X.chin, X.bodyLunge, X.birdDog]),
    D(5, 'Calisthenics C', 'Calistenia C', 'figureStrength', [X.closePush, X.invertedRow, X.bodySquat, X.crunch])
  ]),
  program('calisthenics-upper-lower-4', 'Calisthenics Upper / Lower', 'Calistenia superior / inferior', 'Four bodyweight sessions with a pull-up bar and row anchor.', 'Cuatro sesiones con peso corporal, barra de dominadas y apoyo para remos.', 'hypertrophy', 'intermediate', ['bodyweight'], [
    D(1, 'Upper A', 'Superior A', 'figureStrength', [X.declinePush, X.chin, X.closePush, X.invertedRow]),
    D(2, 'Lower A', 'Inferior A', 'legs', [X.bodySquat, X.bodyLunge, X.deadBug, X.birdDog]),
    D(4, 'Upper B', 'Superior B', 'figureStrength', [X.inclinePush, X.invertedRow, X.chin, X.crunch]),
    D(5, 'Lower B', 'Inferior B', 'legs', [X.bodyLunge, X.bodySquat, X.birdDog, X.deadBug])
  ]),
  program('push-pull-4', 'Push / Pull Four-Day', 'Empuje / tirón en cuatro días', 'Two push and two pull sessions with legs added to each.', 'Dos sesiones de empuje y dos de tirón con piernas en cada una.', 'hypertrophy', 'intermediate', ['gym'], [
    D(1, 'Push A', 'Empuje A', 'barbell', [X.benchHy, X.dbOhp, X.lateral, X.squat5]),
    D(2, 'Pull A', 'Tirón A', 'pullup', [X.pulldown, X.rowHy, X.biceps, X.rdl]),
    D(4, 'Push B', 'Empuje B', 'barbell', [X.incline, X.machineOhp, X.pushdown, X.legPress]),
    D(5, 'Pull B', 'Tirón B', 'pullup', [X.cableRow, X.pulldown2, X.hammer, X.hipThrust])
  ]),
  program('kettlebell-essentials-3', 'Kettlebell Essentials', 'Esenciales con pesa rusa', 'Three sessions using common kettlebell strength movements.', 'Tres sesiones con movimientos habituales de fuerza con pesa rusa.', 'general', 'beginner', ['kettlebell'], [
    D(1, 'Kettlebell A', 'Pesa rusa A', 'dumbbell', [X.kbSquat, X.kbPress, X.kbRow, X.deadBug]),
    D(3, 'Kettlebell B', 'Pesa rusa B', 'dumbbell', [X.kbDead, X.kbLunge, X.kbPress, X.birdDog]),
    D(5, 'Kettlebell C', 'Pesa rusa C', 'dumbbell', [X.kbSwing, X.kbSquat, X.kbRow, X.kbLunge])
  ]),
  program('hypertrophy-5', 'Five-Day Hypertrophy', 'Hipertrofia en cinco días', 'A five-day split with dedicated chest, back, legs and arms work.', 'Cinco días con trabajo específico de pecho, espalda, piernas y brazos.', 'hypertrophy', 'intermediate', ['gym'], [
    D(1, 'Chest & Triceps', 'Pecho y tríceps', 'barbell', [X.benchHy, X.incline, X.cableFly, X.pushdown]),
    D(2, 'Back & Biceps', 'Espalda y bíceps', 'pullup', [X.pulldown, X.rowHy, X.cableRow, X.biceps]),
    D(3, 'Legs', 'Piernas', 'legs', [X.squat5, X.rdl, X.legExt, X.seatedCurl, X.calf]),
    D(5, 'Shoulders & Arms', 'Hombros y brazos', 'figureStrength', [X.dbOhp, X.lateral, X.preacher, X.dbTri]),
    D(6, 'Chest & Back', 'Pecho y espalda', 'barbell', [X.dbBench, X.machineRow, X.machineChest, X.rearDelt])
  ]),
  program('hypertrophy-6', 'Six-Day Hypertrophy', 'Hipertrofia en seis días', 'A six-day push-pull-legs rotation with controlled session size.', 'Rotación de seis días con sesiones de tamaño moderado.', 'hypertrophy', 'advanced', ['gym'], [
    D(1, 'Push A', 'Empuje A', 'barbell', [X.benchHy, X.dbOhp, X.lateral, X.pushdown]),
    D(2, 'Pull A', 'Tirón A', 'pullup', [X.pulldown, X.rowHy, X.dbCurl, X.rearDelt]),
    D(3, 'Legs A', 'Piernas A', 'legs', [X.squat5, X.rdl, X.legExt, X.calf]),
    D(4, 'Push B', 'Empuje B', 'barbell', [X.dbIncline, X.machineOhp, X.cableFly, X.dbTri]),
    D(5, 'Pull B', 'Tirón B', 'pullup', [X.cableRow, X.pulldown2, X.hammer, X.facePull]),
    D(6, 'Legs B', 'Piernas B', 'legs', [X.legPress, X.hipThrust, X.seatedCurl, X.dbLunge])
  ]),
  program('minimal-gym-2', 'Minimal Full Body', 'Cuerpo completo minimalista', 'Two balanced gym days with a compact exercise list.', 'Dos días equilibrados en gimnasio con pocos ejercicios.', 'general', 'beginner', ['gym'], [
    D(1, 'Day A', 'Día A', 'figureStrength', [X.goblet, X.machineChest, X.machineRow, X.crunch]),
    D(4, 'Day B', 'Día B', 'figureStrength', [X.legPress, X.pulldown2, X.machineOhp, X.hipThrust])
  ]),
  program('strength-5x5-four', 'Four-Day 5×5 Strength', 'Fuerza 5×5 en cuatro días', 'Two upper and two lower sessions using distinct barbell variations.', 'Dos sesiones superiores y dos inferiores con variantes de barra.', 'strength', 'intermediate', ['gym'], [
    D(1, 'Upper A', 'Superior A', 'barbell', [lift('0025', 5, 5, 5, 180, 'linear'), lift('0027', 5, 5, 5, 150, 'linear'), X.ohp]),
    D(2, 'Lower A', 'Inferior A', 'legs', [lift('0043', 5, 5, 5, 180, 'linear'), X.rdl, X.calf]),
    D(4, 'Upper B', 'Superior B', 'barbell', [lift('0047', 5, 5, 5, 150, 'linear'), X.pulldown, X.closeBench]),
    D(5, 'Lower B', 'Inferior B', 'legs', [lift('0032', 5, 3, 5, 210, 'double'), X.frontSquat, X.seatedCurl])
  ]),
  program('athletic-full-body-3', 'Athletic Full Body', 'Cuerpo completo atlético', 'Three strength sessions with unilateral leg and upper-back work.', 'Tres sesiones de fuerza con trabajo unilateral de piernas y espalda alta.', 'general', 'intermediate', ['gym'], [
    D(1, 'Athletic A', 'Atlético A', 'figureStrength', [X.frontSquat, X.dbBench, X.supportedRow, X.stepUp]),
    D(3, 'Athletic B', 'Atlético B', 'figureStrength', [X.deadliftHy, X.dbOhp, X.pulldown2, X.dbLunge]),
    D(5, 'Athletic C', 'Atlético C', 'figureStrength', [X.hipThrust, X.incline, X.cableRow, X.bodySquat])
  ]),

  // Twenty new choices add two- to five-day schedules and more home-equipment variety.
  program('gym-full-body-2', 'Full Body Gym Two-Day', 'Cuerpo completo en gimnasio, dos días', 'Two balanced sessions for building a steady gym routine.', 'Dos sesiones equilibradas para crear una rutina constante en el gimnasio.', 'general', 'beginner', ['gym'], [
    D(1, 'Full Body A', 'Cuerpo completo A', 'figureStrength', [X.goblet, X.dbBench, X.pulldown2, X.legCurl, X.deadBug]),
    D(4, 'Full Body B', 'Cuerpo completo B', 'figureStrength', [X.legPress, X.incline, X.cableRow, X.hipThrust, X.calf])
  ]),
  program('dumbbell-full-body-2', 'Dumbbell Full Body Two-Day', 'Cuerpo completo con mancuernas, dos días', 'Two home sessions using a bench and a pair of dumbbells.', 'Dos sesiones en casa con banco y un par de mancuernas.', 'general', 'beginner', ['dumbbells'], [
    D(1, 'Dumbbell A', 'Mancuernas A', 'dumbbell', [X.dbSquat, X.dbBench, X.dbRow, X.dbRdl, X.deadBug]),
    D(4, 'Dumbbell B', 'Mancuernas B', 'dumbbell', [X.dbLunge, X.dbIncline, X.supportedRow, X.dbHip, X.dbOhp, X.dbCalf])
  ]),
  program('bodyweight-foundation-3', 'Bodyweight Foundation Three-Day', 'Base con peso corporal en tres días', 'Three beginner sessions with a sturdy row anchor and simple bodyweight movements.', 'Tres sesiones iniciales con un apoyo firme para remar y movimientos sencillos con peso corporal.', 'general', 'beginner', ['bodyweight'], [
    D(1, 'Foundation A', 'Base A', 'figureStrength', [X.bodySquat, X.inclinePush, X.invertedRow, X.deadBug]),
    D(3, 'Foundation B', 'Base B', 'figureStrength', [X.bodyLunge, X.inclinePush, X.birdDog, X.crunch]),
    D(5, 'Foundation C', 'Base C', 'figureStrength', [X.bodySquat, X.invertedRow, X.inclinePush, X.bodyLunge])
  ]),
  program('band-foundation-3', 'Resistance Band Foundation Three-Day', 'Base con bandas en tres días', 'Three approachable home sessions that cover the main movement patterns.', 'Tres sesiones asequibles en casa que cubren los principales patrones de movimiento.', 'general', 'beginner', ['bands'], [
    D(1, 'Band A', 'Bandas A', 'dumbbell', [X.bandSquat, X.bandChest, X.bandRear, X.bandCurlLeg, X.bandCurl]),
    D(3, 'Band B', 'Bandas B', 'dumbbell', [X.bandRdl, X.bandOhp, X.bandPull, X.bandTri, X.bandCalf]),
    D(5, 'Band C', 'Bandas C', 'dumbbell', [X.bandLunge, X.bandPress, X.bandRow, X.bandLegExt, X.bandRear])
  ]),
  program('kettlebell-full-body-3', 'Kettlebell Full Body Three-Day', 'Cuerpo completo con pesa rusa, tres días', 'Three full-body sessions built around common kettlebell lifts.', 'Tres sesiones de cuerpo completo con ejercicios habituales de pesa rusa.', 'general', 'intermediate', ['kettlebell'], [
    D(1, 'Kettlebell A', 'Pesa rusa A', 'dumbbell', [X.kbSquat, X.kbPress, X.kbRow, X.kbSwing]),
    D(3, 'Kettlebell B', 'Pesa rusa B', 'dumbbell', [X.kbDead, X.kbLunge, X.kbSwing, X.birdDog]),
    D(5, 'Kettlebell C', 'Pesa rusa C', 'dumbbell', [X.kbSquat, X.kbDead, X.kbPress, X.kbRow])
  ]),
  program('upper-lower-general-4', 'Upper / Lower General Four-Day', 'Superior / inferior general en cuatro días', 'Four moderate sessions that alternate upper and lower body.', 'Cuatro sesiones moderadas que alternan tren superior e inferior.', 'general', 'intermediate', ['gym'], [
    D(1, 'Upper A', 'Superior A', 'barbell', [X.benchHy, X.pulldown2, X.cableRow, X.dbOhp, X.crunch]),
    D(2, 'Lower A', 'Inferior A', 'legs', [X.squat5, X.dbRdl, X.legExt, X.legCurl, X.calf]),
    D(4, 'Upper B', 'Superior B', 'barbell', [X.incline, X.machineRow, X.lateral, X.pushdown, X.biceps]),
    D(5, 'Lower B', 'Inferior B', 'legs', [X.legPress, X.hipThrust, X.dbLunge, X.seatedCurl, X.dbCalf])
  ]),
  program('dumbbell-full-body-4', 'Dumbbell Alternating Full Body Four-Day', 'Cuerpo completo alterno con mancuernas en cuatro días', 'Four compact full-body sessions with alternating dumbbell movements.', 'Cuatro sesiones compactas de cuerpo completo con variantes alternas de mancuernas.', 'general', 'intermediate', ['dumbbells'], [
    D(1, 'Full Body A', 'Cuerpo completo A', 'dumbbell', [X.goblet, X.dbBench, X.dbRow, X.deadBug]),
    D(2, 'Full Body B', 'Cuerpo completo B', 'dumbbell', [X.dbRdl, X.dbOhp, X.dbLunge, X.dbCurl]),
    D(4, 'Full Body C', 'Cuerpo completo C', 'dumbbell', [X.dbSquat, X.dbIncline, X.supportedRow, X.dbHip]),
    D(5, 'Full Body D', 'Cuerpo completo D', 'dumbbell', [X.dbLunge, X.dbBench, X.dbFly, X.dbArnold, X.dbCalf])
  ]),
  program('minimal-hypertrophy-2', 'Minimalist Hypertrophy Two-Day', 'Hipertrofia minimalista en dos días', 'Two efficient gym sessions with a small number of hard-working lifts.', 'Dos sesiones eficientes de gimnasio con pocos ejercicios principales.', 'hypertrophy', 'beginner', ['gym'], [
    D(1, 'Full Body A', 'Cuerpo completo A', 'figureStrength', [X.squat5, X.benchHy, X.pulldown, X.legCurl, X.lateral]),
    D(4, 'Full Body B', 'Cuerpo completo B', 'figureStrength', [X.rdl, X.incline, X.cableRow, X.legPress, X.pushdown])
  ]),
  program('band-hypertrophy-3', 'Band Hypertrophy Three-Day', 'Hipertrofia con bandas en tres días', 'Three home sessions with moderate repetitions and controlled band tension.', 'Tres sesiones en casa con repeticiones moderadas y tensión controlada.', 'hypertrophy', 'intermediate', ['bands'], [
    D(1, 'Band A', 'Bandas A', 'dumbbell', [X.bandSquat, X.bandChest, X.bandRow, X.bandRear, X.bandTri]),
    D(3, 'Band B', 'Bandas B', 'dumbbell', [X.bandRdl, X.bandOhp, X.bandPull, X.bandCurl, X.bandRear]),
    D(5, 'Band C', 'Bandas C', 'dumbbell', [X.bandLunge, X.bandPress, X.bandRow, X.bandLegExt, X.bandCalf])
  ]),
  program('dumbbell-hypertrophy-3', 'Dumbbell Hypertrophy Three-Day', 'Hipertrofia con mancuernas en tres días', 'Three home sessions combining compound dumbbell lifts and focused accessories.', 'Tres sesiones en casa que combinan ejercicios compuestos y accesorios con mancuernas.', 'hypertrophy', 'intermediate', ['dumbbells'], [
    D(1, 'Dumbbell A', 'Mancuernas A', 'dumbbell', [X.dbSquat, X.dbBench, X.dbRow, X.dbFly, X.dbCalf]),
    D(3, 'Dumbbell B', 'Mancuernas B', 'dumbbell', [X.dbRdl, X.dbOhp, X.dbLunge, X.dbCurl, X.dbTri]),
    D(5, 'Dumbbell C', 'Mancuernas C', 'dumbbell', [X.goblet, X.dbIncline, X.supportedRow, X.dbHip, X.lateral])
  ]),
  program('upper-lower-volume-4', 'Upper / Lower Hypertrophy Four-Day', 'Hipertrofia superior / inferior en cuatro días', 'Four upper- and lower-body sessions with varied exercise angles.', 'Cuatro sesiones de tren superior e inferior con ángulos de trabajo variados.', 'hypertrophy', 'intermediate', ['gym'], [
    D(1, 'Upper A', 'Superior A', 'barbell', [X.dbBench, X.pulldown, X.cableRow, X.dbOhp, X.cableFly, X.pushdown]),
    D(2, 'Lower A', 'Inferior A', 'legs', [X.frontSquat, X.dbRdl, X.legExt, X.seatedCurl, X.calf]),
    D(4, 'Upper B', 'Superior B', 'barbell', [X.incline, X.cableRow2, X.machineOhp, X.pulldown2, X.preacher, X.facePull]),
    D(5, 'Lower B', 'Inferior B', 'legs', [X.legPress, X.hipThrust, X.dbLunge, X.legCurl, X.dbCalf])
  ]),
  program('machine-hypertrophy-intermediate-4', 'Machine Hypertrophy Four-Day', 'Hipertrofia con máquinas en cuatro días', 'Four stable machine-based sessions for intermediate lifters.', 'Cuatro sesiones estables con máquinas para nivel intermedio.', 'hypertrophy', 'intermediate', ['machines'], [
    D(1, 'Upper A', 'Superior A', 'machine', [X.machineChest, X.machineRow, X.machineOhp, X.pulldown2]),
    D(2, 'Lower A', 'Inferior A', 'machine', [X.legPress, X.legExt, X.legCurl, X.calf]),
    D(4, 'Upper B', 'Superior B', 'machine', [X.machinePress, X.pulldown, X.machineRow, X.machineOhp, X.cableChest]),
    D(5, 'Lower B', 'Inferior B', 'machine', [X.legPress, X.seatedCurl, X.legExt, X.calf])
  ]),
  program('back-delts-hypertrophy-4', 'Back & Delts Hypertrophy Four-Day', 'Espalda y deltoides en cuatro días', 'A four-day gym split with two focused upper-body exposures and balanced legs.', 'División de cuatro días con dos sesiones centradas en el tren superior y piernas equilibradas.', 'hypertrophy', 'intermediate', ['gym'], [
    D(1, 'Back A', 'Espalda A', 'pullup', [X.pulldown, X.supportedRow, X.cableRow, X.facePull, X.dbCurl]),
    D(2, 'Lower A', 'Inferior A', 'legs', [X.frontSquat, X.rdl, X.legCurl, X.calf]),
    D(4, 'Back & Delts B', 'Espalda y deltoides B', 'pullup', [X.machineRow, X.pulldown2, X.lateral, X.rearDelt, X.dbOhp, X.hammer]),
    D(5, 'Lower B', 'Inferior B', 'legs', [X.legPress, X.hipThrust, X.legExt, X.seatedCurl, X.dbCalf])
  ]),
  program('arms-shoulders-hypertrophy-5', 'Arms & Shoulders Specialization Five-Day', 'Especialización de brazos y hombros en cinco días', 'Five gym sessions with two direct arm and shoulder exposures and compact leg work.', 'Cinco sesiones con dos estímulos directos para brazos y hombros y trabajo compacto de piernas.', 'hypertrophy', 'advanced', ['gym'], [
    D(1, 'Chest & Triceps', 'Pecho y tríceps', 'barbell', [X.benchHy, X.incline, X.lateral, X.pushdown]),
    D(2, 'Back & Biceps', 'Espalda y bíceps', 'pullup', [X.pulldown, X.rowHy, X.preacher, X.hammer, X.facePull]),
    D(3, 'Legs', 'Piernas', 'legs', [X.squat5, X.rdl, X.legPress, X.legCurl, X.calf]),
    D(5, 'Arms & Delts', 'Brazos y deltoides', 'figureStrength', [X.dbOhp, X.lateral, X.dbTri, X.dbCurl, X.rearDelt]),
    D(6, 'Chest & Arms', 'Pecho y brazos', 'barbell', [X.dbBench, X.cableFly, X.closeBench, X.cableCurl, X.pushdown])
  ]),
  program('linear-strength-3', 'Linear Strength Three-Day', 'Fuerza lineal en tres días', 'Three beginner barbell sessions with small, repeatable progressions.', 'Tres sesiones iniciales con barra y progresiones graduales y repetibles.', 'strength', 'beginner', ['gym'], [
    D(1, 'Strength A', 'Fuerza A', 'barbell', [lift('0043', 3, 5, 5, 180, 'linear'), lift('0025', 3, 5, 5, 180, 'linear'), X.row5, X.deadBug]),
    D(3, 'Strength B', 'Fuerza B', 'barbell', [lift('0032', 3, 3, 5, 210, 'linear'), lift('0091', 3, 5, 5, 150, 'linear'), X.pulldown, X.calf]),
    D(5, 'Strength C', 'Fuerza C', 'barbell', [lift('1436', 3, 5, 6, 180, 'linear'), X.incline, X.cableRow, X.legCurl])
  ]),
  program('bodyweight-strength-3', 'Bodyweight Strength Three-Day', 'Fuerza con peso corporal en tres días', 'Three progressive sessions using push-ups, rows with a sturdy anchor and unilateral leg movements.', 'Tres sesiones progresivas con flexiones, remos con un apoyo firme y trabajo unilateral de piernas.', 'strength', 'intermediate', ['bodyweight'], [
    D(1, 'Strength A', 'Fuerza A', 'figureStrength', [X.bodySquat, X.declinePush, X.invertedRow, X.deadBug]),
    D(3, 'Strength B', 'Fuerza B', 'figureStrength', [X.bodyLunge, X.closePush, X.invertedRow, X.crunch]),
    D(5, 'Strength C', 'Fuerza C', 'figureStrength', [X.bodySquat, X.inclinePush, X.birdDog, X.bodyLunge])
  ]),
  program('bench-focus-strength-4', 'Bench-Focused Strength Four-Day', 'Fuerza con prioridad de banca en cuatro días', 'Four sessions with two bench exposures, balanced pulling and two lower-body days.', 'Cuatro sesiones con dos estímulos de banca, tirón equilibrado y dos días de tren inferior.', 'strength', 'intermediate', ['gym'], [
    D(1, 'Bench A', 'Banca A', 'barbell', [X.bench6, X.row5, X.closeBench, X.pulldown]),
    D(2, 'Lower A', 'Inferior A', 'legs', [X.squat6, X.rdl, X.legCurl, X.calf]),
    D(4, 'Bench B', 'Banca B', 'barbell', [X.benchHy, X.dbIncline, X.cableRow, X.dbTri, X.facePull]),
    D(5, 'Lower B', 'Inferior B', 'legs', [X.deadlift, X.frontSquat, X.legPress, X.seatedCurl])
  ]),
  program('kettlebell-strength-4', 'Kettlebell Strength Four-Day', 'Fuerza con pesa rusa en cuatro días', 'Four short kettlebell sessions alternating squat, hinge, press and row patterns.', 'Cuatro sesiones cortas con pesa rusa que alternan sentadilla, bisagra, empuje y remo.', 'strength', 'intermediate', ['kettlebell'], [
    D(1, 'Kettlebell A', 'Pesa rusa A', 'dumbbell', [X.kbSquat, X.kbPress, X.kbRow]),
    D(2, 'Kettlebell B', 'Pesa rusa B', 'dumbbell', [X.kbDead, X.kbSwing, X.kbLunge]),
    D(4, 'Kettlebell C', 'Pesa rusa C', 'dumbbell', [X.kbSquat, X.kbPress, X.kbSwing]),
    D(5, 'Kettlebell D', 'Pesa rusa D', 'dumbbell', [X.kbDead, X.kbLunge, X.kbRow])
  ]),
  program('powerlifting-advanced-5', 'Advanced Powerlifting Five-Day', 'Powerlifting avanzado en cinco días', 'Five focused barbell days with heavy practice and shorter supporting work.', 'Cinco sesiones centradas en barra con práctica pesada y accesorios más breves.', 'strength', 'advanced', ['gym'], [
    D(1, 'Squat & Bench', 'Sentadilla y banca', 'barbell', [X.squat6, X.benchHy, X.row5, X.crunch]),
    D(2, 'Bench Strength', 'Fuerza de banca', 'barbell', [X.bench6, X.closeBench, X.pulldown, X.facePull]),
    D(3, 'Deadlift', 'Peso muerto', 'barbell', [X.deadlift, X.frontSquat, X.legCurl, X.calf]),
    D(5, 'Squat Volume', 'Volumen de sentadilla', 'legs', [X.squat5, X.dbBench, X.cableRow, X.pushdown]),
    D(6, 'Bench & Hinge', 'Banca y bisagra', 'barbell', [X.benchHy, X.rdl, X.dbOhp, X.hammer])
  ]),
  program('dumbbell-strength-5', 'Dumbbell Strength Five-Day', 'Fuerza con mancuernas en cinco días', 'Five shorter home sessions with focused lower, push, pull and mixed days.', 'Cinco sesiones breves en casa centradas en tren inferior, empuje, tirón y trabajo mixto.', 'strength', 'intermediate', ['dumbbells'], [
    D(1, 'Lower A', 'Inferior A', 'dumbbell', [X.dbSquat, X.dbRdl, X.dbCalf]),
    D(2, 'Push', 'Empuje', 'dumbbell', [X.dbBench, X.dbOhp, X.dbTri, X.lateral]),
    D(3, 'Pull', 'Tirón', 'dumbbell', [X.dbRow, X.supportedRow, X.dbCurl, X.rearDelt]),
    D(5, 'Lower B', 'Inferior B', 'dumbbell', [X.dbLunge, X.dbHip, X.goblet, X.dbCalf]),
    D(6, 'Upper Mix', 'Superior mixto', 'dumbbell', [X.dbIncline, X.dbArnold, X.hammer, X.dbFly])
  ])
]

const BUILTIN_IDS = new Set(CATALOGUE.map(ex => ex.id))
const GOALS = new Set(['strength', 'hypertrophy', 'general'])
const LEVELS = new Set(['beginner', 'intermediate', 'advanced'])
const EQUIPMENT = new Set(['gym', 'machines', 'dumbbells', 'bands', 'bodyweight', 'kettlebell'])

// This is intentionally executable validation: the picker can stay closed if bundled catalog
// data ever drifts from the exercise catalogue or the weekly model's limits.
export function validateRoutineCatalog(catalog = CATALOG) {
  const errors = []
  const ids = new Set()
  const signatures = new Set()
  for (const p of catalog) {
    if (!p?.id || ids.has(p.id)) errors.push(`duplicate or missing program id: ${p?.id || '(empty)'}`)
    ids.add(p?.id)
    if (!GOALS.has(p.goal)) errors.push(`${p.id}: invalid goal`)
    if (!LEVELS.has(p.level)) errors.push(`${p.id}: invalid level`)
    if (!Array.isArray(p.equipment) || !p.equipment.length || p.equipment.some(e => !EQUIPMENT.has(e))) errors.push(`${p.id}: invalid equipment`)
    if (!Array.isArray(p.sessions) || p.sessions.length < 2 || p.sessions.length > 6) errors.push(`${p.id}: frequency must be 2–6 sessions`)
    const days = new Set()
    for (const s of p.sessions || []) {
      if (!Number.isInteger(s.day) || s.day < 0 || s.day > 6 || days.has(s.day)) errors.push(`${p.id}: invalid or repeated weekday`)
      days.add(s.day)
      if (!Array.isArray(s.exercises) || !s.exercises.length) errors.push(`${p.id}: empty session`)
      const exerciseIds = new Set()
      for (const e of s.exercises || []) {
        if (!BUILTIN_IDS.has(e.id)) errors.push(`${p.id}: unknown exercise ${e.id}`)
        if (exerciseIds.has(e.id)) errors.push(`${p.id}: repeated exercise ${e.id} in one session`)
        exerciseIds.add(e.id)
        if (!Number.isInteger(e.sets) || e.sets < 1 || e.sets > 6) errors.push(`${p.id}: invalid sets for ${e.id}`)
        if (!Number.isInteger(e.repsMin) || !Number.isInteger(e.reps) || e.repsMin < 1 || e.reps < e.repsMin || e.reps > 30) errors.push(`${p.id}: invalid rep range for ${e.id}`)
        if (!Number.isInteger(e.restSec) || e.restSec < 30 || e.restSec > 300) errors.push(`${p.id}: invalid rest for ${e.id}`)
        if (!['linear', 'double', 'triple'].includes(e.prog) || e.mode !== 'reps') errors.push(`${p.id}: invalid progression or mode for ${e.id}`)
      }
    }
    const signature = JSON.stringify((p.sessions || []).map(s => ({
      day: s.day,
      exercises: (s.exercises || []).map(({ id, sets, repsMin, reps, restSec, prog, mode }) => ({ id, sets, repsMin, reps, restSec, prog, mode }))
    })))
    if (signatures.has(signature)) errors.push(`${p.id}: duplicate program content`)
    signatures.add(signature)
  }
  if (ids.size !== 60 || catalog.length !== 60) errors.push(`expected 60 programs, found ${catalog.length}`)
  return errors
}

const deepFreeze = value => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}

export const ROUTINE_CATALOG = deepFreeze(CATALOG)
export const ROUTINE_CATALOG_ERRORS = Object.freeze(validateRoutineCatalog(ROUTINE_CATALOG))
