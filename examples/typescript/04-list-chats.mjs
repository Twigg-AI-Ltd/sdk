// List every chat in a namespace (and the namespaces beneath it), newest first.
// Iterating fetches further pages as needed.
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg();

for await (const chat of twigg.chats.list({ namespace: "examples" })) {
  console.log(chat.id, chat.namespace, chat.title, chat.updated_at);
}
