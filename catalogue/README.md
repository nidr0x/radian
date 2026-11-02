# Radian exercise catalogue

Every exercise in Radian's catalogue lives here, one file each, in plain JSON. The app is built from these
files, so a fix merged here is in the next release for everyone.

- **Browse the list:** [browse/](browse/README.md), one page per body part, each exercise with a link to its picture.
- **Report something without editing:** open an
  [exercise issue in Radian](https://github.com/nidr0x/radian/issues/new).

## What's where

| Path | What it holds |
|---|---|
| `exercises/<id>.json` | One exercise in English: name, body part, equipment, muscles, description, steps |
| `i18n/<lang>.json` | Translations: `{ "<id>": { "name", "description", "instructions" } }` |
| `frontend/public/exercise-media/workout-guide/` | Selected exercise illustrations used by the PWA; see the included attribution and license files |
| `browse/` | Generated overview pages. Don't edit, they are rebuilt |

The id is the exercise's permanent number. Workouts, routines and records store it, so **an id is
never changed, reused or deleted.** A duplicate is fixed by improving one entry, not by removing
the other.

## Fixing an exercise

Open `exercises/<id>.json` (the browse pages link straight to it) and press the pencil on GitHub.

```json
{
  "id": "0025",
  "name": "barbell bench press",
  "bodyPart": "chest",
  "equipment": "barbell",
  "target": "pectorals",
  "secondaryMuscles": ["triceps", "shoulders"],
  "category": "strength",
  "description": "The classic flat-bench press. Builds the chest, front shoulders and triceps.",
  "instructions": [
    "Lie on a flat bench with your eyes under the bar and your feet flat on the floor.",
    "..."
  ]
}
```

- **name**: lowercase, equipment first ("dumbbell incline curl"). The app capitalises it.
- **bodyPart, equipment, target, secondaryMuscles, category**: only the words listed at the top of
  [`scripts/catalogue/validate.mjs`](../scripts/catalogue/validate.mjs). The app filters, translates
  and draws the muscle map from them, so a new word needs app support first. Ask in an issue.
- **description**: one or two sentences on what the movement is and what it trains.
- **instructions**: 4 to 7 short steps, second person ("Brace your core..."). No em dashes.
- **muscleMap** (optional): a more precise muscle-map drawing with the body map's own muscle names
  and weights from 0 to 1. Only needed when target and secondaryMuscles don't draw it right.
- **femaleVariant / variantOf**: links the same exercise drawn on a female figure. Leave as is.
- **textSource: "exercisedb"**: the original 1,324 entries. Their text came under MIT (see NOTICE.md).
  You can still improve them.

## Translating

Translations go in `i18n/<lang>.json`, keyed by id. Anything missing falls back to English, so
partial work is welcome. Translate the name and as much of the steps as you like:

```json
{
  "0025": {
    "name": "Bankdrücken mit der Langhantel",
    "description": "Der Klassiker auf der Flachbank ...",
    "instructions": ["Leg dich so auf die Flachbank, dass ...", "..."]
  }
}
```

Languages: `ar bn de es fr hi hu it ko pl pt pt-BR ru th tr uk zh zh-TW` (the app's languages).
Names follow the language's own conventions. German capitalises nouns; the others are stored
lowercase like English.

## Rules that keep this open

1. **Write it yourself.** Don't copy names, descriptions or steps from other apps, websites, books
   or datasets, and don't paste machine translation unreviewed. Short, correct, plain beats long.
2. **Use media with documented terms.** The Radian PWA currently excludes the legacy Gym visual
   images and animations and uses the separately attributed Workout Guide collection instead.
   Their terms and provenance are recorded in [media/NOTICE.md](media/NOTICE.md). The Workout Guide
   illustrations have their own attribution and license files under
   `frontend/public/exercise-media/workout-guide/`.
3. **No medical advice.** Describe the movement, not treatments.

## Checking your change

You don't need to run anything: the **Catalogue** check on your pull request does it and says which
file and field is wrong. To run it yourself (Node 20+):

```sh
node scripts/catalogue/validate.mjs     # checks every entry
node scripts/catalogue/build.mjs        # regenerates the app's data files and browse/
```

Commit the regenerated files with your change, or leave that to the maintainer.
