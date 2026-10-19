# Address a chat by your own id, such as the sender's phone number, instead of Twigg's chat id.
# The first message creates the chat; every message after it lands in the same one. Each message
# is one request, which suits a webhook or an automation step that only knows who wrote in.
from twigg import Twigg

twigg = Twigg(model="gpt-6-luna")


def on_message(sender: str, text: str) -> str:
    chat = twigg.chat_by_external_id(f"whatsapp:{sender}", chat={"namespace": "examples"})
    return chat.send(text).text


print(on_message("+447700900123", "Hi, my name is Ann."))
print(on_message("+447700900123", "What's my name?"))

record = twigg.chats.get_by_external_id("whatsapp:+447700900123")
print(f"chat {record.id}, {record.length} parts")
