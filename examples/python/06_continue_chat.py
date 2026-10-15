# Pick up the most recent chat and carry the conversation on.
# Nothing is stored locally: Twigg holds the history, so a chat id is all you need.
from twigg import Twigg

twigg = Twigg(model="gpt-6-luna")

page = twigg.chats.list(namespace="examples", limit=1)
if not page.data:
    raise SystemExit("No chats yet; run 02_send.py first")

chat = twigg.chat(page.data[0])
reply = chat.send("Summarise what we've talked about so far in one sentence.")
print(reply.text)
