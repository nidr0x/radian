import type { OpenGymConversionState } from '../src/lib/radian-conversion.js';

export interface RadianMigration {
  format: string;
  accountId: string;
  migrationId: string;
  sourceChecksum: string;
  stateChecksum: string;
  reconciliation: { sessionSets: { source: number; converted: number }; [key: string]: unknown };
  state: OpenGymConversionState;
}

export function convertRadianBackup(input: unknown, accountId: string): RadianMigration;
export function migrateFiles(options: {
  inputPath: string;
  outputPath: string;
  rollbackPath: string;
  accountId: string;
}): Pick<RadianMigration, 'sourceChecksum' | 'stateChecksum'> & { outputPath: string; rollbackPath: string };
