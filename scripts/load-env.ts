// Loads .env.local then .env for CLI scripts and the standalone worker (Next.js does this itself for the app).
// ENV_FILE (e.g. ".env.worker") is loaded first and wins; the first file to set a variable takes precedence.
import { config } from "dotenv";

config({ path: [process.env.ENV_FILE, ".env.local", ".env"].filter((p): p is string => !!p), quiet: true });
