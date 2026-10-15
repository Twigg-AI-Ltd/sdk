# Iterate a stream's typed events instead of just the text: RunEvent, BlockStartEvent,
# DeltaEvent, BlockStopEvent, DoneEvent and friends. Useful for a UI or for debugging.
from twigg import DeltaEvent, Twigg

twigg = Twigg(model="gpt-6-luna")
chat = twigg.chats.open(namespace="examples", title="Events example")

with chat.stream("Say hello in three languages.") as stream:
    for event in stream:
        if isinstance(event, DeltaEvent):
            print("delta", event.kind, repr(event.text))
        else:
            print(type(event).__name__, event)
    result = stream.final()

print("\nblocks:", len(result.blocks), "text:", result.text)
