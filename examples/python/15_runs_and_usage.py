# Every turn is a run. Inspect one (status, latency, final cost once billing settles), list a
# chat's runs and its totals, then ask for the organisation's usage over the last 24 hours, split
# by model.
from twigg import Twigg
from twigg.types import ModelUsageGroup

twigg = Twigg(model="gpt-6-luna")
chat = twigg.chats.open(namespace="examples", title="Runs example")
reply = chat.send("Say hi.")
chat.send("And goodbye.")

run = twigg.runs.wait_for_settlement(reply.run_id)
print("run:", run.id, run.status, f"{run.latency_ms}ms", "cost:", run.cost, "settled:", run.settled_at)

for r in chat.runs():
    print("  ", r.id, r.origin, r.status, r.usage.output_tokens if r.usage else None)
usage = chat.get(include="usage").usage
if usage:
    print("chat:", usage.runs, "runs, cost:", usage.cost, f"({usage.unsettled_runs} unsettled)")

report = twigg.usage.query(range="24h", group_by="model")
for row in report.rows:
    model = row.group.model_name if isinstance(row.group, ModelUsageGroup) else "?"
    print(f"{model!s:<30} runs: {row.runs} cost: {row.cost}")
