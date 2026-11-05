# Delete every chat the examples created, in the examples namespace and beneath it, in one call.
from twigg import Twigg

twigg = Twigg()

deleted = twigg.namespace("examples").chats.delete_all().deleted
print(f"{deleted} chats deleted")
