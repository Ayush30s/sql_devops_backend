const int = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

export const config = {
  /** Where this API listens. */
  port: int("PORT", 4000),
  /** The frontend's public URL: the only origin allowed to make browser mutations. */
  appUrl: process.env.APP_URL ?? "http://localhost:3000",
  logRequests: process.env.LOG_REQUESTS !== "false",
  sessionDays: 30,
  sql: {
    statementTimeoutMs: int("SQL_STATEMENT_TIMEOUT_MS", 3000),
    /** Hard cap for a whole sandbox session; enforced by terminating the backend. */
    sessionTimeoutMs: int("SQL_SESSION_TIMEOUT_MS", 15000),
    maxRows: int("SQL_MAX_ROWS", 500),
    maxCompareRows: 5000,
    maxCellChars: 2000,
    maxSqlLength: 20000,
    maxStatements: 50,
  },
  lab: {
    commandTimeoutMs: int("LAB_COMMAND_TIMEOUT_MS", 5000),
    maxCommandLength: int("LAB_MAX_COMMAND_LENGTH", 2000),
    maxOutputBytes: int("LAB_MAX_OUTPUT_BYTES", 65536),
    workers: int("LAB_WORKERS", 2),
  },
};

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
