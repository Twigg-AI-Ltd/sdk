# Scope a client to one namespace, publish system instructions there, chat under them,
# then withdraw the instructions again so the namespace is back as it was.
from twigg import Twigg

twigg = Twigg(model="gpt-6-luna")
scope = twigg.namespace("examples").child("pirate")  # examples/pirate

scope.config.instructions.publish(mode="append", body="Always answer like a pirate.")
try:
    chat = scope.chats.open(title="Instructions example")
    print(chat.send("What's the capital of France?").text)
finally:
    scope.config.instructions.withdraw()
