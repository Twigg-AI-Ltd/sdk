# Bring a conversation that started elsewhere into Twigg, then carry on with it. The import only
# writes to an empty chat, so running it twice is safe: the second time answers `skipped`.
import time

from twigg import Twigg
from twigg.types import ImportSkippedResponse

twigg = Twigg(model="gpt-6-luna")
chat = twigg.chat_by_external_id(
    f"examples:import-{time.time_ns()}", chat={"namespace": "examples"}
)

imported = chat.import_history(
    [
        {"type": "prompt", "text": "Hi, I'm Ann. Where is order 7?"},
        {
            "type": "tool_call",
            "tool_use_id": "c1",
            "name": "track_order",
            "arguments": {"order": 7},
        },
        {
            "type": "tool_result",
            "tool_use_id": "c1",
            "tool_name": "track_order",
            "text": "Shipped today",
        },
        {"type": "message", "text": "Order 7 shipped today."},
    ]
)
if isinstance(imported, ImportSkippedResponse):
    print(f"already had {imported.existing_parts} parts")
else:
    print(f"stored {imported.imported_parts} parts for ${imported.cost}")
    for warning in imported.warnings:
        print(f"  {warning.code}: {warning.message}")

again = chat.import_history([{"type": "prompt", "text": "Not stored"}])
print(
    "second import skipped" if isinstance(again, ImportSkippedResponse) else "second import stored"
)

print(chat.send("What's my name, and which order did I ask about?").text)
chat.delete()
