# Open a new chat and send one message, waiting for the whole reply.
# Prints the text, what it cost, and the token usage.
from twigg import Twigg

twigg = Twigg(model="gpt-6-luna")

chat = twigg.chats.open(namespace="examples", title="Send example")
reply = chat.send("Give me three names for a pet hedgehog.")

print(reply.text)
print("\ncost:", reply.cost, reply.cost_currency)
print("usage:", reply.usage)
print("chat:", chat.id)
