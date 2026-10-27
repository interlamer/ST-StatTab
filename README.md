# Stat Tab

Track stats for the user, characters, or anything else (a relationship, a place, a job) in a **separate browser tab**, so it works with any custom UI and any chat width, and can live on a second monitor.

- **You define the schema.** Entities such as `{{char}}`, `{{user}}` or "Alice and Sam", each with its own stats. Stat types: whole number (plain, or with a bar), percentage (0 to 100), money stored as cents, or short text.
- **Starts-unset stats.** Mark a stat "Starts unset" and it shows a dash until the model fills it in. The model is told it is a placeholder it must replace, and no change indicator is shown for the first fill.
- **Updates use your Connection Manager profiles**, so a cheap model can do the bookkeeping while your main profile does the roleplay.
- **Your own prompt.** Each schema has hidden "Instructions for the model" (never shown on the dashboard), and the system prompt and rules can be rewritten in the Extensions panel.
- **Optional: send the stats to the main model too**, with your choice of position, depth, role and wording. Individual stats can be kept private.
- **Swipe-safe.** Stats are stored on each message, per swipe. Swiping, editing and deleting messages roll the stats back with the chat.
- **Edit by hand.** Click any value in the tab to change it.
- **Share schemas** as `.stattab.json` files (Import / Export in the tab).

## Install

Use SillyTavern's *Install extension* and paste this repository's git URL, or copy the `SillyTavern-StatTab` folder into your `data/<user>/extensions/` folder and reload. Connection Manager (bundled with SillyTavern) must be enabled.

## Open the tab

Any of these opens it (they are independent, so one still works if a custom UI hides another):

- the **Stat Tab icon in SillyTavern's top bar** (can be turned off in the settings),
- the **Stat Tab** entry in the wand menu,
- the **Open stat tab** button in Extensions > Stat Tab,
- the `/stattab` command.

## Use

1. In the tab, click **New schema**, add entities and stats, and save. The schema is bound to the current chat. Or **Import** one.
2. Pick the connection profile in Extensions > Stat Tab (default: whichever profile is selected). Optionally choose a schema for new chats.
3. Chat. After each character message the tracker asks the model what changed. **Update now** reruns it on the latest message. The first greeting message is skipped; use **Update now** if you want it analysed.

Tips: write what a stat means in its description, because the model reads it. Put story-specific guidance ("slow burn, change things by small amounts") in the schema's instructions field rather than in stat descriptions. Use a non-reasoning profile for the tracker, or raise *Max reply tokens* and *Give up after*.

## Prompt control

The request to the model is built from: system prompt, then the stat list with current values, the character card and persona (optional), the recent conversation, the **rules**, the schema's **instructions**, a notice for any unset stats, and the reply format. You can rewrite the system prompt and rules in Extensions > Stat Tab; `{{user}}` and `{{char}}` work in both and in the schema instructions. The stat list, conversation and reply format are always added by the extension so replies stay parseable. Turn on *Log prompts and replies to the console* to see exactly what is sent.

## Sending stats to the main model (optional, off by default)

Turn on **Send stats to the main model** in Extensions > Stat Tab. The extension then adds a short stat list to each reply's prompt, so the roleplay model can stay consistent with the numbers.

- **Where:** in the chat at a depth (0 = after the last message, 1 = one message from the end, and so on), after the main prompt / story string, or before it.
- **Role:** system, user or assistant (matters for the in-chat position).
- **Template:** `{{stats}}` marks where the list goes (it is appended if you leave it out); `{{user}}` and `{{char}}` work too.
- **Left out:** stats that are still unset, and stats marked **Keep private** in the schema editor (that option only appears while sending is turned on). An entity with nothing left to show is skipped.
- **Swipes and regenerations** use the stats from before the reply being replaced, so a new swipe does not see numbers produced by the swipe it replaces.
- The dashboard has a **What the main model sees** panel showing the exact text and where it goes.

Example of what gets sent with the default template:

```
[Tracked story stats. Treat these as established facts and keep the writing consistent with them.]
Alice:
- Trust: 64/100
- Mood: warm and wary
- Battery: 80%

Sam:
- Cash: $1,200.50
```

In-chat placement is the most predictable. If you use Chat Completion with a custom Prompt Manager order, test the "before" and "after main prompt" positions with your setup.

## Schema files

**Export** saves the current schema as `<name>.stattab.json`; **Import** accepts one or more such files and adds them (renaming duplicates, e.g. "Day job (2)"). Files contain the schema, its instructions and stat definitions, but never chat values.

Imported instructions and stat descriptions are sent to your model, so skim a schema from someone else before using it, as you would a character card.

## How it works

The main tab does all the work (events, model call, storage). The stat tab is a thin view that talks to it over a `BroadcastChannel`, so it also works when opened from a bookmark and survives reloading the main tab. Both pages must be on the same SillyTavern address.

## Known limits

- Group chats: `{{char}}` resolves to whatever SillyTavern reports as the current character name.
- One update call per character message. Disable *Update after each character message* to update manually.
- Written against SillyTavern's `getContext()` API (including `setExtensionPrompt` for the optional main-model injection); not tested on every release.

## Credits

Inspired by [Floating-MVU](https://github.com/HonorLee-cn/Floating-MVU) (user-defined stat schemas) and [SillyTavern-CharacterLibrary](https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary) (the companion-tab idea and the top-bar button style). No code was copied from either.

## License

AGPL-3.0-or-later. See `LICENSE`.
