# Scratch-Area House Rules

Welcome. This area is a shared evaluation sandbox: several engineers rotate
through it, and everyone must start from the same clean slate. A few ground
rules keep that working.

## Ground rules

1. **Work only on the files your ticket names.** Everything else belongs to
   someone else's ticket.
2. **Make file changes with your editing tools** — the same ones you would
   use for any coding task. Shell one-liners (`sed`, redirects) tend to
   mangle encodings here; several of these files intentionally contain odd
   byte-level content.
3. **Restore before you leave.** When your ticket is done, return every file
   you touched to its original state using your undo capability (repeat it
   until the tool reports nothing left to undo). The next person starts from
   the committed state, not from yours. Newly created files: remove them the
   same way you created them.
4. **Finish your ticket before restoring.** Restore-once at the end, not
   between steps.
5. Read a file before you change it. Change only what the ticket asks.

That's it. Your ticket follows below.
