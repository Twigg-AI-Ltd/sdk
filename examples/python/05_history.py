# Print the transcript of the most recent chat in the namespace, oldest first.
# `after_ordinal=-1` pages forwards from the start; without it history runs newest first.
from twigg import Twigg

twigg = Twigg()

page = twigg.chats.list(namespace="examples", limit=1)
if not page.data:
    raise SystemExit("No chats yet; run 02_send.py first")
latest = page.data[0]

print(f"# {latest.title or latest.id}\n")
for item in twigg.chat(latest).history(after_ordinal=-1):
    text = getattr(item.part, "text", None)
    if text is None:
        text = item.part.model_dump_json()
    print(f"[{item.ordinal}] {item.part.type}: {text}")
