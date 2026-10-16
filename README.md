# sudoc

An experimental language for human-authored agent contracts. Indentation defines blocks like Python. The executable first pass makes interpretation explicit, compiles to a constrained execution format, verifies source-to-artifact correspondence, and runs a synthetic dropdown synchronization workflow with independent acceptance checks.

Start with [Sudoc v1](docs/SUDOC.md) for the executable syntax, guarantees, and limitations:

```sh
node cli.js inspect examples/dropdown-sync.sudoc
node cli.js compile examples/dropdown-sync.sudoc --out /tmp/dropdown-sync.sudoc.json
node cli.js verify examples/dropdown-sync.sudoc /tmp/dropdown-sync.sudoc.json
node cli.js run examples/dropdown-sync.sudoc /tmp/dropdown-sync.sudoc.json --fixture examples/dropdown-sync.fixture.json
```

The demo changes only an in-memory fixture. Live JEV is opt-in. Source without a `VERSION` declaration retains the legacy authoring-only syntax below; it cannot compile or execute.

```text
@WORKFLOW:
    DEFINE $SOURCE AS my list
    FOR EACH $ITEM IN $SOURCE:
        WHERE $ITEM needs attention
        IF $ITEM is ready:
            DO process $ITEM
        ELSE:
            NOTE why $ITEM is not ready
            STOP RECORD
```

## Try it in Neovim

From this directory, run `npm run editor`. It opens Neovim with the local plugin loaded and `examples/dropdown-sync.sudoc` open. Your Neovim configuration is not modified. Node.js 20+ and Neovim with `vim.system` (0.10+) are required; tested on Neovim 0.12.1.

- Live diagnostics check unsaved edits after a 200 ms pause.
- `:SudocLint` checks the current buffer immediately.
- `:SudocFormat` normalizes indentation and keywords, changing the buffer without saving it.
- `:lua vim.diagnostic.open_float()` shows the error at the cursor.
- Syntax highlighting distinguishes structural keywords, strings, URLs, and comments.
- Open `examples/playground.workflow` for a smaller starting point.

To load it in an existing Neovim session:

```vim
:luafile /Users/josephshomefolder/development/ai-experiments/workflow-language/nvim/workflow.lua
```

The plugin supports files already open, and future `.sudoc` and `.workflow` buffers. The old `:WorkflowLint` and `:WorkflowFormat` commands remain aliases. It changes indentation settings only for workflow buffers. It uses Neovim's built-in diagnostics directly; no language-server setup or plugin-manager dependency is needed. It does not add snippets or a custom indent expression yet: indent blocks manually, then use the formatter to normalize spacing.

## Optional VS Code adapter

The original adapter remains available for experimentation. From the project directory:

```sh
code --new-window --extensionDevelopmentPath="$PWD" "$PWD/examples/location-sms.workflow"
```

This opens an Extension Development Host; the extension is not installed globally.

- Edit either example. Errors appear as underlines and in the Problems panel.
- Use **Format Document** (Shift+Option+F on macOS) to normalize indentation and keywords.
- Use completion (Control+Space) for block/step snippets.
- A file with syntax errors is not formatted: fix the Problems entries first.
- Open `examples/playground.workflow` for a smaller starting point.

## Terminal

Node.js 20+; zero runtime dependencies.

```sh
npm test
npm run test:nvim
node cli.js lint examples/location-sms.workflow
node cli.js format examples/playground.workflow
node cli.js format examples/playground.workflow --write
```

Formatting prints to stdout unless `--write` is provided. Use `-` as the filename to read stdin, and `lint - --json` for structured editor diagnostics. `format - --write` is rejected. Exit codes: 0 = success (warnings allowed), 1 = syntax errors, 2 = usage/filesystem error. `npm run lint -- <file>` and `npm run format -- <file>` are shortcuts.

## Plan a workflow with an agent

The repository ships a project skill at `.agents/skills/workflow-planner`. Agents that discover project skills can invoke `$workflow-planner` with a `.workflow` file to lint its structure and build their own grounded execution plan from its loops, branches, notes, and stop conditions.

The skill treats a workflow as source material, not executable code or authorization. It plans both decision branches, surfaces missing inputs and permissions, and does not carry out actions when the request is only to plan.

## Syntax v0

| Form | Meaning |
| --- | --- |
| `@WORKFLOW:` | Declare the one file-wide workflow object, in column 1 |
| `USING approach` | A tool or working instruction |
| `DEFINE $NAME AS description` | Give a descriptive value a reusable name |
| `FOR EACH $RECORD IN source:` | A loop whose record variable exists inside the loop |
| `WHERE condition` | Optional first direct statement inside a loop |
| `DO action` / `THEN action` | An action; both mean the same thing |
| `IF condition:` | Conditional block |
| `ELSE:` | Alternative immediately after IF, at the same indentation |
| `NOTE destination and message` | Describe what to record and where |
| `STOP RECORD` | End this iteration of the nearest loop; continue with its next record |
| `STOP @WORKFLOW` | End the workflow declared by this file |
| `# comment` | Whole-line comment; ignored structurally |

Block headers require a trailing colon and at least one indented statement. Any consistent space indentation is accepted; formatting uses four spaces per level. Tabs are rejected. Keywords are case-insensitive and formatted uppercase. All actions and conditions fit on one line in v0. Inline comments, ELSE IF, functions, variable reassignment, and multiline continuations are not defined yet.

The header declares the single global `@WORKFLOW` object. Every downstream `@WORKFLOW` visibly links back to that object; the filename supplies its human-readable name. `$UPPERCASE_NAMES` identify local values instead. A variable definition becomes available after its line in the current indentation block and all nested blocks. Loop variables exist only inside their loop. Undefined, duplicate, out-of-scope, and lowercase local names are errors; unused local variables are warnings. Any other `@NAME` is undefined.

Only workflow references, variable references, keywords, and structure are checked. Everything else after DEFINE, DO, THEN, USING, NOTE, WHERE, and IF is natural-language text. Descriptions such as `$RECORD's Location Code value` communicate intent to a reader or agent; they are **not evaluated** in v0. Column spellings, URLs, quotes, predicate truth, contradictory instructions, and SMS recipients are not validated. Syntax-valid does not mean ready to execute.

The SMS example is a hypothetical draft with non-routable placeholder URLs. Comments expose unresolved assumptions about stopping the whole batch and selecting the failure-note column. It uses the row's location-code value as the SMS body. No spreadsheet or external CRM instance was accessed.

## Change the language

Executable v1 modules:

- `sudoc-language.js`: parser, contract validation, and formatter.
- `sudoc-compiler.js`: compilation, canonical hashes, and source/artifact verification.
- `sudoc-catalog.js` / `sudoc-runtime.js`: registered operations and bounded execution.
- `sudoc-jev.js`: explicitly invoked live judgment adapter.
- `sudoc-*.test.js`: compiler tampering, runtime failure injection, CLI, and provider validation.

Legacy and shared tooling:

- `language.js`: recognized statements, indentation tree, checks, and formatter. Both CLI and editor use it.
- `language.test.js`: intended behavior; start here when changing syntax.
- `.agents/skills/workflow-planner`: repository skill that translates authored workflows into agent-owned plans.
- `extension.js`: live diagnostics, formatting, and completion.
- `cli.js` / `cli.test.js`: terminal behavior.
- `nvim/workflow.lua` / `nvim/test.lua`: Neovim plugin and real headless editor integration tests.
- `open-editor.js`: launches Neovim with the local plugin using absolute paths.
- `workflow.tmLanguage.json` / `language-configuration.json`: highlighting and editor indentation.
- `editor.test.js`: integration checks run inside VS Code's actual extension host.

Re-run the editor tests with isolated VS Code state:

```sh
code --user-data-dir /tmp/workflow-experiment-test-profile --extensions-dir /tmp/workflow-experiment-test-extensions --extensionDevelopmentPath="$PWD" --extensionTestsPath="$PWD/editor.test.js" --disable-workspace-trust --skip-welcome --skip-release-notes
```

The host exits after tests and writes `editor-test-results.json` locally (gitignored). `docs/PLAN.md` records the scope; `docs/RESEARCH.md` records related work. No dependency on those languages.
