# Sudoc first pass

Implementation contract accepted in the design discussion, with a separate worktree requested by Joseph.

- Worktree: managed `sudoc-first-pass`; branch `feat/sudoc-first-pass`, based on committed main `01bee0c`.
- Rename product and authoring tools to sudoc; support `.sudoc` while retaining `.workflow` authoring compatibility.
- Provide explicit deterministic actions, checks, and bounded interpretation with evidence, independent JEV acceptance, budgets, and uncertainty handling.
- Compile to a small versioned execution format and verify its complete correspondence with source before running.
- Demonstrate five source dropdowns across three target objects using synthetic data; no external CRM writes.
- Include offline adapters, an explicitly invoked live JEV adapter, inspectable contracts, and execution traces.
- Test malformed source, artifact tampering, missing freedom boundaries, uncertainty, budget exhaustion, and partial failures; run actual Neovim and VS Code tests.
- Commit and push the branch to origin after verification. Preserve the original checkout and its untracked example and notes symlink.

First-pass implementation choice: named requirement templates and a closed operation catalog. Arbitrary prose-to-contract generation and an OS-isolated live agent host are not claimed. Structural identity lowering is verified; natural-language intent, model truth, and the runtime binary are not formally proven.
