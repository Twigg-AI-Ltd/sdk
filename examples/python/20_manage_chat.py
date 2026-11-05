# Rename a chat and change its metadata, and keep your own data beside a message with
# client_data: stored with the part, never sent to the model, and read back from history.
from twigg import Twigg

twigg = Twigg(model="gpt-6-luna")
chat = twigg.chats.open(
    namespace="examples", title="Untitled", user_metadata={"channel": "web", "trial": True}
)

chat.send({"type": "prompt", "text": "I'd like a refund.", "client_data": {"message_id": "m-1"}})

# Fields left out are unchanged; a metadata key passed as None is removed.
updated = chat.update(title="Refund request", user_metadata={"trial": None, "tier": "gold"})
print(updated.title, updated.user_metadata)  # Refund request {'channel': 'web', 'tier': 'gold'}

page = chat.history(after_ordinal=-1, include_client_data=True)
for part in page.data:
    print(part.role, part.part.type, part.client_data or "")
chat.delete()
