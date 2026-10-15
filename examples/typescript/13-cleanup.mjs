// Delete every chat the examples created in the examples namespace.
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg();

const chats = await Array.fromAsync(twigg.chats.list({ namespace: "examples" }));
for (const chat of chats) {
  await twigg.chats.delete(chat.id);
  console.log("deleted", chat.id, chat.title);
}
console.log(`${chats.length} chats deleted`);
