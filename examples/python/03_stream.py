# Stream a reply, printing text as it arrives, then read the final result.
from twigg import Twigg

twigg = Twigg(model="gpt-6-luna")
chat = twigg.chats.open(namespace="examples", title="Stream example")

with chat.stream("Explain what a hash table is in one paragraph.") as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
    reply = stream.get_final_response()

print("\n\nstop reason:", reply.stop_reason, "cost:", reply.cost)
