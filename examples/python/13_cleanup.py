# Delete every chat the examples created in the examples namespace.
from twigg import Twigg

twigg = Twigg()

chats = list(twigg.chats.list(namespace="examples"))
for chat in chats:
    twigg.chats.delete(chat.id)
    print("deleted", chat.id, chat.title)
print(f"{len(chats)} chats deleted")
