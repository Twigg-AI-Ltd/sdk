// Delete every chat the examples created, in the examples namespace and beneath it, in one call.
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg();

const { deleted } = await twigg.namespace("examples").chats.deleteAll();
console.log(`${deleted} chats deleted`);
