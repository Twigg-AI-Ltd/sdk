// Address a chat by your own id, such as the sender's phone number, instead of Twigg's chat id.
// The first message creates the chat; every message after it lands in the same one. Each message
// is one request, which suits a webhook or an automation step that only knows who wrote in.
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg({ model: "gpt-6-luna" });

async function onMessage(from, text) {
  const chat = twigg.chatByExternalId(`whatsapp:${from}`, { chat: { namespace: "examples" } });
  const reply = await chat.send(text);
  return reply.text;
}

console.log(await onMessage("+447700900123", "Hi, my name is Ann."));
console.log(await onMessage("+447700900123", "What's my name?"));

const record = await twigg.chats.getByExternalId("whatsapp:+447700900123");
console.log(`chat ${record.id}, ${record.length} parts`);
