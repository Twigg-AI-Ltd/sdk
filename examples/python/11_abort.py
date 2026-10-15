# Start a long reply and stop it once ~300 characters of text have arrived. abort() stops the turn on Twigg,
# not just this connection, and the stream ends with stop reason "aborted".
from twigg import Twigg

twigg = Twigg(model="gpt-6-luna")
chat = twigg.chats.open(namespace="examples", title="Abort example")

received = 0
with chat.stream("Write a 2000 word essay on the history of bread.") as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
        received += len(text)
        if received > 300:
            stream.abort()
            break
    result = stream.final()

print("\n\nstop reason:", result.stop_reason, "cost:", result.cost)
