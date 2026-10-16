# Sudoc v1: executable contracts

Sudoc is an experimental language for generating task-specific execution structure. Its core rule is that ambiguity grants no freedom: interpretation requires explicit author-declared scope, capabilities, evidence, budget, and acceptance criteria. This first pass demonstrates that rule with synthetic dropdown synchronization dropdown definitions. It does not connect to external CRM.

## Quick start

Node.js 20+; no runtime dependencies.

```sh
npm test
npm run test:nvim
node cli.js lint examples/dropdown-sync.sudoc
node cli.js inspect examples/dropdown-sync.sudoc
node cli.js compile examples/dropdown-sync.sudoc --out /tmp/dropdown-sync.sudoc.json
node cli.js verify examples/dropdown-sync.sudoc /tmp/dropdown-sync.sudoc.json
node cli.js run examples/dropdown-sync.sudoc /tmp/dropdown-sync.sudoc.json --fixture examples/dropdown-sync.fixture.json
```

`compile --out` creates a new file and refuses to replace an existing file. Omit `--out` to print JSON. `inspect --json` exposes the plan, source references, and interpretation boundaries. `run` requires both source and artifact and verifies correspondence before running any operation. Runs clone the fixture into memory and print JSON with status, outputs, report, state, and trace. They do not save property changes to the fixture.

Exit status 0 means successful lint, format, compilation, verification, or execution. Status 1 means invalid source/artifact, failed execution, or review required. Status 2 means command usage or input-file errors. Legacy `lint`/`format` retain their existing interface, including stdin `-` and JSON diagnostics.

## Source language

Executable documents start with `@WORKFLOW:` and contain `VERSION 1` and `ON FAILURE STOP`. Keywords are uppercase and case-sensitive in v1. Spaces define nesting; tabs are rejected. The formatter normalizes consistent indentation to four spaces without changing prose or JSON strings. Whole-line `#` comments and blank lines are supported.

Declare inputs and outputs before executable statements:

```text
@WORKFLOW:
    VERSION 1
    INPUT $PORTAL AS Number
    OUTPUT $REPORT AS List
    ON FAILURE STOP

    CHECK portal_matches:
        WITH portal = $PORTAL
        WITH expected = 100001
```

Types are `Number`, `Text`, `Boolean`, `List`, and `Record`. Inputs arrive as JSON, keyed by their complete `$NAME`. Expressions are JSON literals or references such as `$PLAN.expected`. Object keys must be unique; literals reject non-finite numbers and negative zero, which cannot survive artifact JSON serialization unchanged. Numbers otherwise use JavaScript Number semantics. No JavaScript evaluation, imports, shell execution, arbitrary function calls, or implicit natural-language conditions occur.

Supported statements:

| Statement | Meaning |
| --- | --- |
| `RUN action AS $RESULT:` | Call a registered deterministic operation with `WITH name = expression` bindings; result binding is optional. |
| `CHECK template:` | Expand a registered requirement into an exact runtime check with explicit bindings. |
| `FOR EACH $ITEM IN expression:` | Execute the body sequentially for a list. |
| `IF expression == literal:` / `!=` | Compare JSON values structurally; optional adjacent `ELSE:` handles the alternative. |
| `INTERPRET decision AS $RESULT:` | Delegate only the declared decision, under the required fields below. |
| `PROVIDE $OUTPUT = expression` | Assign a declared output; required on every successful path. |

A no-argument call uses a trailing colon and no nested bindings, for example `RUN build_report AS $RESULT:`. Result variables are lexical: values created within a branch or loop cannot escape it. Outputs cannot be assigned inside loops. Static checks catch unknown actions, missing/extra arguments, missing producers, and statically known output type errors; dynamic fields and operation-specific shapes are checked at runtime.

### Explicit freedom

```text
INTERPRET label_mapping AS $MAPPING:
    QUESTION "Do these conflicting labels represent equivalent business meanings?"
    USING read_definitions
    LIMIT 3
    EVIDENCE property = $PLAN
    ACCEPT JEV "Every conflicting option must preserve its business meaning. Unclear equivalence requires review."
    CONFIDENCE 0.9
    ON UNKNOWN REVIEW
    ON REJECT FAILURE
```

Every field is required. `LIMIT` counts the initial proposal request plus each capability call. For example, `LIMIT 3` permits one proposal request and at most two tool calls. It does not bound the private reasoning of a remote model. The host also imposes an adapter deadline and global execution-step limit. In v1 the only registered decision is `label_mapping` and the only agent capability is `read_definitions`. It reads the current plan's supplied definitions, without obtaining access to fixture writes or other targets.

The runtime invokes the agent adapter once per interpretation block. That adapter can perform several bounded capability calls before returning; automatic model retries or repair loops are not implemented. The agent returns a structured mapping proposal. The runtime checks its structure and original labels, then sends the proposal and evidence to a separate judge with the source-authored question and acceptance criterion. An agent cannot replace that criterion or directly authorize a write. An accepted judgment below `CONFIDENCE`, an unknown answer, unavailable evaluator, or invalid response cannot pass the acceptance gate. High-confidence rejection fails the run; unknown or insufficient confidence requires review.

The acceptance threshold is an author choice, not a guarantee of accuracy. Confidence and the probability assigned to an outcome are different values. The adapter preserves both when available.

### Requirement templates

The supported requirement vocabulary lives in `sudoc-catalog.js`; `inspect` shows its precise descriptions alongside the source. This first pass deliberately uses named templates rather than claiming to understand arbitrary prose. Unsupported requirements produce diagnostics instead of being guessed.

`preserve_existing` checks the proposed expected definition before a write. `matches_expected` checks fresh read-back data after a write. Their underlying comparison code is generated into the execution structure by binding the template to source variables; authors need not write comparison loops.

The catalog is deliberately small and domain-specific in this first slice. Additional domains require reviewed operation implementations and requirement templates. General-purpose action discovery, arbitrary prose-to-contract generation, and automatic repair loops are future work.

## The dropdown synchronization demonstration

The source declares five Users properties and three target object types, creating 15 combinations. All source dropdowns are validated before the first write. New properties copy the source's ordered options. Existing properties preserve their original options and append missing ones in source order.

The fixture includes creation, an additive update, an unchanged dropdown, and `North` versus `Northern` as an explicitly delegated label conflict. A recorded proposal and recorded acceptance demonstrate the agent/judge boundary offline. These are simulation fixtures, not evidence of a live model's judgment.

Trusted v1 operation rules also require portal confirmation, preflight registration of targets, a preservation check before applying a plan, and verification of all targets before successful completion. These rules are part of the fixed catalog/runtime contract. A workflow that omits the steps cannot claim success merely because its artifact corresponds to its source.

Failure stops subsequent operations. Earlier successful changes remain in the in-memory run state; there is no rollback guarantee. Reports retain the status of each target, including unattempted ones. Read-back verification can detect a bad write but cannot retroactively prevent it.

## What correspondence establishes

The compiled JSON artifact contains a versioned program, exact source hash, contract hash, and source locations. The verifier independently reparses source and compares the complete supported program rather than trusting hashes supplied by the compiler. Unknown fields, omitted or additional actions, reordered steps, changed arguments, changed conditions, altered capabilities/budgets/rubrics, and stale source are rejected. Source locations refer to the containing operation; child bindings are represented within its contract.

This is a checked identity lowering: the parsed contract is the runtime's execution format. It avoids a second unrestricted code-generation stage. It is not a machine-checked theorem about arbitrary generated programs. The parser, verifier, interpreter, registered operations, and host adapters form the trusted implementation. A shared parser bug could affect compilation and verification together. Hashes identify artifacts; they are not authorization signatures.

Three claims stay separate:

1. **Meaning:** an author reviews whether the precise contract captures their intent. The compiler cannot prove the meaning of unrestricted prose.
2. **Correspondence:** supported source contracts and the executed structure match, including the exact locations where freedom is permitted.
3. **Run evidence:** one run records its operations, proposals, judgments, and checks. A model judgment is not proof of semantic truth, and a fixture receipt is not evidence of a real external write.

The artifact format and catalog are v1 and should be used with the same runtime release that compiled them. This first pass does not attest the runtime binary or sandbox arbitrary JavaScript plugins. Host-supplied adapter functions are trusted code; capability enforcement applies to the tools handed to them, not to code that independently uses Node's filesystem/network APIs. A production untrusted-agent adapter requires process isolation and credential mediation.

## Live JEV and adapters

Offline fixture adapters are the default. To evaluate the interpretation with TypeSafe explicitly:

```sh
node cli.js run examples/dropdown-sync.sudoc /tmp/dropdown-sync.sudoc.json \
    --fixture examples/dropdown-sync.fixture.json --live-jev
```

Set `TYPESAFE_API_KEY` in the process environment. This sends the authored question and acceptance rubric together with the interpretation evidence and proposal to TypeSafe; the agent proposal remains the fixture's recorded proposal. Property operations remain local and in memory. No credentials are stored in source, compiled artifacts, or traces. `--model` accepts a pinned version, defaulting to `jev-1.13.0`. No provider calls occur during lint, format, compile, inspect, verify, or ordinary fixture runs.

The adapter uses TypeSafe's [evaluation endpoint](https://docs.typesafe.ai/api) and [Choice primitive](https://docs.typesafe.ai/primitives/choice), checked 2026-10-16. Responses are validated for model identity, outcome set, finite confidence, normalized probabilities, and a winning choice. Provider failures and timeouts lead to an unresolved evaluation, never implicit acceptance. No automatic retry seeks a more favorable decision.

Programmatic interfaces:

```js
const { compile, verify } = require('./sudoc-compiler');
const { run } = require('./sudoc-runtime');
const artifact = compile(source);
const checked = verify(source, artifact); // { valid, diagnostics }
const result = await run(source, artifact, { fixture, inputs: fixture.inputs, agent, judge });
```

Agent and judge adapters are functions supplied by the host. See `sudoc-runtime.js` and its fault-injection tests for the exact proposal and callback contracts. The live adapter is `createJevJudge` from `sudoc-jev.js`.
