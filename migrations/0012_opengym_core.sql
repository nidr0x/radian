-- openGym's structured training domain. This is intentionally not a serialized user state:
-- routines, sessions, sets, measurements and account preferences have account-scoped rows.
-- Unknown top-level fields are retained one field at a time in gym_state_fields so a newer
-- client can round-trip them without turning D1 into a document store.

CREATE TABLE gym_sync_state (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  write_id TEXT,
  updated_at TEXT NOT NULL,
  state_timestamp INTEGER,
  reset_at INTEGER
);

CREATE TABLE gym_profile (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT,
  unit TEXT CHECK (unit IS NULL OR unit IN ('kg', 'lb')),
  language TEXT,
  theme TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE gym_settings (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 65536),
  updated_revision INTEGER NOT NULL DEFAULT 0 CHECK (updated_revision >= 0),
  PRIMARY KEY (account_id, setting_key)
);

-- Forward-compatible storage for individual openGym state fields that do not yet have a
-- normalized domain table. Large arrays and media must be split into rows or R2 objects.
CREATE TABLE gym_state_fields (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 65536),
  updated_revision INTEGER NOT NULL DEFAULT 0 CHECK (updated_revision >= 0),
  PRIMARY KEY (account_id, field_key)
);

CREATE TABLE gym_state_collection_presence (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection_key TEXT NOT NULL,
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  PRIMARY KEY (account_id, collection_key)
);

CREATE TABLE gym_routines (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  routine_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  name TEXT NOT NULL,
  day_key TEXT,
  progression_json TEXT CHECK (progression_json IS NULL OR (json_valid(progression_json) AND length(progression_json) <= 65536)),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND length(details_json) <= 65536),
  updated_revision INTEGER NOT NULL DEFAULT 0 CHECK (updated_revision >= 0),
  PRIMARY KEY (account_id, routine_id)
);

CREATE TABLE gym_routine_exercises (
  account_id TEXT NOT NULL,
  routine_id TEXT NOT NULL,
  exercise_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  prescription_json TEXT NOT NULL CHECK (json_valid(prescription_json) AND length(prescription_json) <= 65536),
  PRIMARY KEY (account_id, routine_id, position),
  FOREIGN KEY (account_id, routine_id) REFERENCES gym_routines(account_id, routine_id) ON DELETE CASCADE
);
CREATE INDEX gym_routine_exercises_account_exercise ON gym_routine_exercises(account_id, exercise_id);

CREATE TABLE gym_custom_exercises (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  name TEXT NOT NULL,
  muscle_group TEXT,
  equipment TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND length(details_json) <= 65536),
  updated_revision INTEGER NOT NULL DEFAULT 0 CHECK (updated_revision >= 0),
  PRIMARY KEY (account_id, exercise_id),
  UNIQUE (account_id, position)
);

CREATE TABLE gym_sessions (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  routine_id TEXT,
  session_date TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  note TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND length(details_json) <= 65536),
  updated_revision INTEGER NOT NULL DEFAULT 0 CHECK (updated_revision >= 0),
  PRIMARY KEY (account_id, session_id),
  UNIQUE (account_id, position)
);
CREATE INDEX gym_sessions_account_date ON gym_sessions(account_id, session_date DESC, session_id);
CREATE INDEX gym_sessions_account_routine_date ON gym_sessions(account_id, routine_id, session_date DESC);

CREATE TABLE gym_session_exercises (
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  exercise_position INTEGER NOT NULL CHECK (exercise_position >= 0),
  exercise_id TEXT NOT NULL,
  name TEXT,
  note TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND length(details_json) <= 65536),
  PRIMARY KEY (account_id, session_id, exercise_position),
  FOREIGN KEY (account_id, session_id) REFERENCES gym_sessions(account_id, session_id) ON DELETE CASCADE
);
CREATE INDEX gym_session_exercises_account_exercise ON gym_session_exercises(account_id, exercise_id, session_id);

CREATE TABLE gym_session_sets (
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  exercise_position INTEGER NOT NULL,
  set_position INTEGER NOT NULL CHECK (set_position >= 0),
  set_type TEXT,
  reps REAL,
  load REAL,
  duration_seconds REAL,
  distance REAL,
  speed REAL,
  effort REAL,
  rest_seconds REAL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND length(details_json) <= 65536),
  PRIMARY KEY (account_id, session_id, exercise_position, set_position),
  FOREIGN KEY (account_id, session_id, exercise_position)
    REFERENCES gym_session_exercises(account_id, session_id, exercise_position) ON DELETE CASCADE
);

CREATE TABLE gym_bodyweight (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  measured_on TEXT NOT NULL,
  weight REAL NOT NULL,
  unit TEXT CHECK (unit IS NULL OR unit IN ('kg', 'lb')),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND length(details_json) <= 65536),
  updated_revision INTEGER NOT NULL DEFAULT 0 CHECK (updated_revision >= 0),
  PRIMARY KEY (account_id, entry_id),
  UNIQUE (account_id, position)
);
CREATE INDEX gym_bodyweight_account_date ON gym_bodyweight(account_id, measured_on DESC);

CREATE TABLE gym_body_measurements (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  measured_on TEXT NOT NULL,
  values_json TEXT NOT NULL CHECK (json_valid(values_json) AND length(values_json) <= 65536),
  updated_revision INTEGER NOT NULL DEFAULT 0 CHECK (updated_revision >= 0),
  PRIMARY KEY (account_id, entry_id),
  UNIQUE (account_id, position)
);
CREATE INDEX gym_body_measurements_account_date ON gym_body_measurements(account_id, measured_on DESC);

CREATE TABLE gym_favourites (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (account_id, exercise_id)
);

CREATE TABLE gym_equipment_profiles (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  details_json TEXT NOT NULL CHECK (json_valid(details_json) AND length(details_json) <= 65536),
  PRIMARY KEY (account_id, profile_id)
);

CREATE TABLE gym_cards (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  details_json TEXT NOT NULL CHECK (json_valid(details_json) AND length(details_json) <= 65536),
  PRIMARY KEY (account_id, card_id)
);

CREATE TABLE gym_exercise_notes (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL,
  note TEXT NOT NULL,
  updated_revision INTEGER NOT NULL DEFAULT 0 CHECK (updated_revision >= 0),
  PRIMARY KEY (account_id, exercise_id)
);

CREATE TABLE gym_exercise_weights (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL,
  weight REAL NOT NULL,
  measured_on TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND length(details_json) <= 65536),
  updated_revision INTEGER NOT NULL DEFAULT 0 CHECK (updated_revision >= 0),
  PRIMARY KEY (account_id, exercise_id)
);

-- Existing accounts get an empty version row lazily when they first use the new API. No
-- account, passkey, or legacy sync_records row is read or changed by this migration.
