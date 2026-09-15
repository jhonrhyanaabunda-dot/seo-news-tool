/**
 * Run background processing locally without waiting for cron:
 *   npm run scan:once                 # one tick (schedule + process), 4-minute budget
 *   npm run scan:once -- --until-idle # keep ticking until no work is queued
 */
import "./load-env";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({ options: { "until-idle": { type: "boolean", default: false }, budget: { type: "string", default: "240" } } });
  const { runTick } = await import("@/lib/jobs/runner");
  const { sqlClient } = await import("@/lib/db");
  let round = 0;
  do {
    round++;
    const r = await runTick({ budgetMs: Number(values.budget) * 1000, workerId: `cli-${process.pid}`, role: "cli" });
    console.log(JSON.stringify({ round, ...r }, null, 2));
    if (r.processed === 0) break;
  } while (values["until-idle"]);
  await sqlClient.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
