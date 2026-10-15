# List the models this organisation can use, with their context window.
# The `name` is what you pass as `model` everywhere else.
from twigg import Twigg

twigg = Twigg()

for model in twigg.models.list():
    print(f"{model.name:<30} {model.context_window}")
