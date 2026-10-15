// Every turn is a run. Inspect one (status, latency, final cost once billing settles),
// then ask for the organisation's usage over the last 24 hours, split by model.
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg({ model: "gpt-6-luna" });
const chat = await twigg.chats.open({ namespace: "examples", title: "Runs example" });
const reply = await chat.send("Say hi.");

const run = await twigg.runs.waitForSettlement(reply.runId);
console.log("run:", run.id, run.status, `${run.latency_ms}ms`, "cost:", run.cost, "settled:", run.settled_at);

const report = await twigg.usage.query({ range: "24h", group_by: "model" });
for (const row of report.rows) {
  // group_by: "model" types every row's group as a ModelUsageGroup (in TypeScript)
  console.log(String(row.group.model_name).padEnd(30), "runs:", row.runs, "cost:", row.cost);
}
