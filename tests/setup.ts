import { existsSync } from "node:fs";
import path from "node:path";

/** The backend's own .env, the same one `npm run dev` reads. */
const file = path.resolve(import.meta.dirname, "..", ".env");
if (existsSync(file)) process.loadEnvFile(file);
