# List every chat in a namespace (and the namespaces beneath it), newest first.
# Iterating fetches further pages as needed.
from twigg import Twigg

twigg = Twigg()

for chat in twigg.chats.list(namespace="examples"):
    print(chat.id, chat.namespace, chat.title, chat.updated_at)
