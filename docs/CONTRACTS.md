# Contract authoring version 1

`CONTRACT 1` adds explicit typed dependencies and outcome handling to the indentation-based workflow authoring language. It describes a workflow for a person or agent to interpret; it does not fetch sources, evaluate conditions, or invoke actions.

```text
@WORKFLOW:
    CONTRACT 1
    INPUT $CUSTOMER AS Customer FROM "request.customer"
    INPUT $MESSAGE AS Text FROM "request.locationCode"
    OUTPUT $RECEIPT AS SmsReceipt
    CONDITION $CAN_SEND AS $CUSTOMER.smsEnabled == true

    DECIDE $CAN_SEND:
        WHEN true:
            DO send_sms:
                WITH to = $CUSTOMER.phone
                WITH body = $MESSAGE
                PRODUCES $RECEIPT
                ON success:
                    EXIT SUCCESS
                ON failure:
                    EXIT FAILURE
                ON unknown:
                    EXIT REVIEW
        WHEN false:
            EXIT FAILURE
        WHEN unknown:
            EXIT REVIEW
```

The [complete SMS example](../examples/sms-contract.workflow) includes prose guidance for its branches. Bindings such as `request.customer` name external inputs; they are authored assertions about source and type. Readiness does not confirm that the source exists, consent was observed, or a provider accepted a message.

## Declarations and scope

Each file has exactly one `@WORKFLOW:`. `CONTRACT 1` is its first non-`NOTE` statement. Comments and blank lines do not count. At least one `INPUT`, one `OUTPUT`, and one named `CONDITION` are required.

| Statement | Meaning |
| --- | --- |
| `INPUT $NAME AS Type FROM "source.path"` | Declare a typed external input with a nonempty source binding |
| `OUTPUT $NAME AS Type` | Declare an output promised by every successful workflow exit |
| `CONDITION $NAME AS expression` | Declare a named decision from a formal expression |
| `PROVIDE $OUTPUT = expression` | Assign a compatible, available value to a declared workflow output |
| `NOTE prose` | Record human-readable guidance; referenced variables must be available |

Input and condition values are immutable. They become visible after declaration in their indentation scope and nested scopes. Names must use `$UPPERCASE_NAMES` and cannot be redeclared or shadowed elsewhere in the file. `OUTPUT` declarations belong directly in the workflow and establish file-wide slots; declaring a slot does not make its value available. Their availability comes from `PROVIDE` or a successful action that `PRODUCES` that output.

`FROM ?`, incomplete expression values `?`, and draft templates remain editable. Lint labels explicit holes as warnings; `check` treats them as errors. In both modes `ready` is false. Malformed syntax and invalid types remain errors. Formatting requires unambiguous structure, but not completed contracts.

## Conditions and expressions

Expressions support:

- Scoped variables and field paths, such as `$CUSTOMER.phone`.
- Double-quoted JSON strings, finite decimal numbers, `true`, `false`, and `unknown`.
- `==`, `!=`, `<`, `>`, `<=`, and `>=`.
- `NOT`, `AND`, `OR`, and parentheses.

Precedence is comparison, `NOT`, `AND`, then `OR`; parentheses override it. Ordered comparisons require numbers. Equality requires compatible types. Boolean operators require Boolean or Decision operands. There is no arithmetic, function invocation, JavaScript evaluation, implicit prose predicate, or string interpolation in formal expressions. Strings containing `$NAMES` are literal strings.

Conditions are three-way decisions. Unknown observations must remain distinguishable from false observations. `DECIDE $CONDITION:` requires exactly one `WHEN true:`, `WHEN false:`, and `WHEN unknown:`. The checker conservatively examines all three alternatives even for a literal condition; it does not evaluate predicates or use model judgments to prune branches.

## Actions, results, and termination

`DO action_name:` refers to a catalog signature. Its children are:

- `WITH argument = expression` for each required argument, with type checking.
- Exactly one `PRODUCES $RESULT`, binding either a declared output or a new scoped result.
- `ON success:`, `ON failure:`, and `ON unknown:` branches, each exactly once.
- Optional `NOTE` guidance.

The produced value is available only in the success branch. A local action result remains scoped to that branch. A declared output can remain available after the action only if every continuing path produces it. Paths that terminate with failure or review do not need a successful result. The same intersection rule applies when decision branches converge.

Use `PROVIDE $REPORT = $LOCAL_RECEIPT.id` to project an available typed result into a different compatible output. Input bindings and conditions cannot be overwritten by `PRODUCES` or `PROVIDE`.

Every path must end explicitly:

- `EXIT SUCCESS` requires all promised workflow outputs to be available on that path.
- `EXIT FAILURE` declares unsuccessful completion and promises no successful output.
- `EXIT REVIEW` declares unresolved uncertainty and promises no successful output.

Statements after an unconditional terminal point receive an unreachable warning. A successful contract check establishes the consistency of declared paths and types, not real-world correctness or authorization.

## Catalogs and templates

The built-in catalog defines `Text`, `PhoneNumber`, `Number`, `Boolean`, `Decision`, `Evidence`, `Customer`, and `SmsReceipt`. `PhoneNumber` is a nominal subtype of `Text`: declaring it asserts that the external source provides that kind of value. No phone-number lookup or deliverability test occurs.

`Customer` has `phone: PhoneNumber`, `name: Text`, and `smsEnabled: Boolean`. `SmsReceipt` has `id: Text`, `to: PhoneNumber`, and `status: Text`. The `send_sms` action requires `to: PhoneNumber` and `body: Text`, produces `SmsReceipt`, and declares success/failure/unknown outcomes.

A JSON catalog can add types and actions or explicitly override a domain definition. Invalid references, malformed signatures, and cyclic base types are rejected. The intrinsic scalar meanings of `Text`, `Number`, `Boolean`, and `Decision` cannot be changed by adding bases or fields; internal analysis names `Invalid` and `Unknown` are reserved. Catalogs contain metadata only; they do not load executable handlers.

```json
{
  "types": {
    "Report": { "fields": { "summary": "Text" }, "description": "A comparison report." }
  },
  "actions": {
    "draft_report": {
      "description": "Write a report from the supplied evidence.",
      "arguments": { "evidence": { "type": "Evidence", "required": true } },
      "output": "Report",
      "outcomes": ["success", "failure", "unknown"]
    }
  }
}
```

Run `node cli.js check report.workflow --catalog catalog.json`. JSON catalogs use the same schema as `catalog.js`; a field maps directly to a type name, and an action argument maps to an object with `type`, optional `required` (defaults to true), and optional `description`. Inheritance establishes nominal assignment compatibility; record fields are declared on their record type. CLI and programmatic services support custom catalogs; editor adapters currently use built-ins.

`node cli.js template workflow` emits a draft contract skeleton. `template send_sms` emits an action block with explicit argument holes. `template sms` emits the complete illustrative workflow. Editor template commands insert the same visible source. Templates are not runtime macros.

## Compatibility and implementation limits

Files without a `CONTRACT` statement retain the original v0 interpretation. `node cli.js lint` continues checking their structure and scoped aliases. `node cli.js check` refuses to call them ready and points to explicit migration. Adding a contract marker opts into the new grammar; unsupported statements become diagnostics rather than silently acquiring different meaning.

Version 1 deliberately uses `DECIDE` and typed `DO` blocks. Legacy `FOR EACH`, `WHERE`, `IF`/`ELSE`, descriptive `DEFINE`, and `STOP` remain v0 features. Converting a loop-heavy legacy document requires an authoring decision about its record scope; there is no automatic migration or executable loop semantics in this version. The first complete contract example describes one SMS request.

Language services share the deterministic parser across CLI, Neovim, and VS Code. They supply scoped symbols, typed fields/arguments, templates, declaration navigation, hover, and exact ranges. They do not introduce a language-server dependency. Model review is an explicit separate command; see [Jev review](JEV.md). Normal authoring and readiness checks work offline without credentials.
