// The trace store's settings, read by name from the environment object given. Pure; main.ts turns a missing or
// malformed setting into an exit naming it.

export type TraceStoreSettings = {
  databasePath: string;
  // How many spans are kept, the newest by arrival.
  retainSpans: number;
};

function required(env: Readonly<Record<string, string | undefined>>, name: string, meaning: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`${name} is not set. It is ${meaning}.`);
  return value;
}

export function settingsFrom(env: Readonly<Record<string, string | undefined>>): TraceStoreSettings {
  const retain = required(env, 'TELEMETRY_RETAIN_SPANS', 'how many spans are kept, a whole number of 1 or more');
  const retainSpans = /^[0-9]+$/.test(retain) ? Number(retain) : NaN;
  if (!Number.isSafeInteger(retainSpans) || retainSpans < 1) {
    throw new Error('TELEMETRY_RETAIN_SPANS is not a whole number of 1 or more.');
  }
  return {
    databasePath: required(env, 'TELEMETRY_DB_PATH', 'the path of the SQLite file that holds the spans'),
    retainSpans,
  };
}
