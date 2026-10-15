// Test code that uses the SDK without a network or credits: MockTwigg has the same
// surface, backed by an in-memory Twigg answering with scripted turns.
import { MockTwigg, streamBuilder } from "@twigg/sdk/testing";

const twigg = new MockTwigg({ model: "any-model" }).respond(
  streamBuilder().text("Hello from the mock!").done(),
);

const chat = await twigg.chats.open({ namespace: "test" });
const reply = await chat.send("Hi");

console.log(reply.text);
console.log("requests made:", twigg.server.calls.map((c) => `${c.method} ${c.path}`));
