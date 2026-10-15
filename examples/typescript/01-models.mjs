// List the models this organisation can use, with their context window.
// The `name` is what you pass as `model` everywhere else.
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg();

for (const model of await twigg.models.list()) {
  console.log(model.name.padEnd(30), model.context_window);
}
