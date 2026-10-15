# What failures look like: every error is a TwiggError with status, code, message and hint,
# and subclasses let you catch by kind.
from twigg import NotFoundError, Twigg, TwiggError

twigg = Twigg(model="gpt-6-luna")

try:
    twigg.chats.get("00000000-0000-0000-0000-000000000000")
except NotFoundError as err:
    print("not found:", err.message)

try:
    chat = twigg.chats.open(namespace="examples")
    chat.send("Hi", model="no-such-model")
except TwiggError as err:
    print(type(err).__name__, err.status, err.code, err.message, err.hint)
