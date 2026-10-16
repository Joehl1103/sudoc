# Optional Jev semantic review

The deterministic checker owns types, dependencies, output availability, formal conditions, and branch completeness. Jev adds a separate, explicitly requested review of meaning. Importing the module, editing, completing, formatting, and linting do not contact TypeSafe. This tool never executes a workflow or sends an SMS.

## Run a review

Provide `TYPESAFE_API_KEY` through your shell environment, then run:

```sh
node cli.js review examples/sms-contract.workflow --json
node cli.js review examples/sms-contract.workflow --model jev-1.13.0 --json
```

Neovim uses `:WorkflowReview`; VS Code uses **Workflow: Review Meaning with Jev**. These commands send selected document fragments and relevant catalog descriptions to TypeSafe. Review does not fetch any source named in an `INPUT ... FROM` binding. There is no background or on-save model request. Keep credentials out of workflow files, catalogs, and committed configuration.

Without credentials, review returns `unreviewed` with reason `missing-credentials`; ordinary authoring remains available offline. A contract with deterministic errors returns `invalid` before any request. Legacy documents are `unreviewed` because the bounded rules require explicit contracts.

## What gets reviewed

`buildReviewCandidates(source, options)` is an offline preview of the evidence and questions. It derives candidates from reachable nodes in the shared parser; statements after a terminal exit on every path are excluded:

- Each typed action argument: compare the bound expression and directly referenced input declarations with the catalog's argument purpose.
- Each `NOTE` within an action or conditional branch: compare its prose with that adjacent action/outcome or named condition/branch.

These are narrow semantic questions. They do not establish actual consent, delivery, external data validity, or the runtime truth of a condition. A source path or variable name can suggest intent but is insufficient evidence for an unstated business fact. Notes outside those contexts, direct assignments, cross-step policy conflicts, and the overall business process are outside these rules. `reviewed` means all extracted reachable candidates received valid answers, not that all document meaning was proved correct.

Every question has three choices: `supported`, `contradicted`, and `insufficient_evidence`. Diagnostics use application-authored messages, one-based source ranges, and `category: "model"`. Contradictions are warnings; supported and insufficient-evidence results are informational. Each diagnostic retains the returned probabilities and confidence. No confidence threshold turns a judgment into a deterministic error or changes readiness. Editor adapters keep model diagnostics separate from contract diagnostics.

## Results and bounds

The public API is `await review(source, { apiKey, model, fetch, signal, catalog })`. Omitting `apiKey` reads the environment; an explicit empty string disables an inherited credential. `fetch` injection supports network-free tests. `signal` cancels a request.

Results include `status`, `reason`, `diagnostics`, `completedQuestions`, `totalQuestions`, `omitted`, `documentHash`, `catalogHash`, `requestedModel`, `model`, `rubricVersion`, and `reviewKey` when a contract could be analyzed. `model` records the provider's actual model after a successful response. Status meanings:

| Status | Meaning |
| --- | --- |
| `reviewed` | All extracted candidates received structurally valid typed responses. |
| `unreviewed` | Missing credentials, cancellation, unsupported document, no candidates, or incomplete coverage due to limits. |
| `unavailable` | Network, timeout, HTTP, or invalid provider response prevented review. |
| `invalid` | Contract errors or invalid input/catalog configuration prevented review. |

Caps are 256 KiB of source, 12 questions, 8 KiB per evidence slice, and 64 KiB per request. Oversized slices are omitted whole, never silently truncated. Partial results retain completed diagnostics but remain `unreviewed`, with explicit omissions. The default timeout is 10 seconds; callers can set `timeoutMs` up to 30 seconds. Timeout and cancellation are bounded even if an injected transport ignores its abort signal. No automatic retry increases requests or cost. Provider bodies, keys, and transport error strings are not copied into diagnostics.

No disk cache is used. `documentHash` identifies the exact source bytes represented by the JavaScript string; `reviewKey` also includes catalog contents, requested model, and rubric version. Adapters clear semantic findings on edits and reject responses when document version or request generation changes. A future cache or catalog hot-reload adapter must also compare `reviewKey`; matching source text alone is insufficient after a catalog/model/rubric change.

## Provider contract and verification

The integration uses native `fetch` against `POST https://api.typesafe.ai/v1/systemone`, with bearer authentication and a JSON body containing `model`, structured `state`, and typed `questions`. It validates complete answer IDs, choice type, allowed outcomes, finite probability distributions, their sum, the selected maximum, confidence bounds, and a versioned response model. An explicitly requested version must match the response exactly; `jev-latest` and `jev-preview` may resolve to a versioned ID. Malformed catalog configuration returns `invalid` with a fixed reason without exposing catalog details. Response text is never used as diagnostic prose. See the [official HTTP reference](https://docs.typesafe.ai/api) and [Choice reference](https://docs.typesafe.ai/primitives/choice).

The default is pinned to `jev-1.13.0`. On 2026-10-15, the [official model documentation](https://docs.typesafe.ai/models) listed `jev-1.14.0` as the newest release/preview while `jev-latest` still resolved to `jev-1.13.0`. An explicit version avoids silent changes from moving aliases; callers can override it deliberately with another `jev-X.Y.Z` version or the documented `jev-latest` / `jev-preview` aliases.

`node --test semantic-review.test.js` uses synthetic documents and mocked responses only. It verifies evidence scope, typed request/response handling, uncertainty labels, malformed responses, offline behavior, cancellation, timeouts, size limits, and review identity. These tests verify integration behavior, not model accuracy. No business document or live provider request was used to implement or test this module.

Before treating findings as dependable, evaluate the rules against labeled examples of sound contracts, explicit contradictions, and missing evidence, including reordered answer options and adversarial prose. The documented [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) include numerical reasoning, indirection, large irrelevant context, option order, and susceptibility to instructions embedded in data. The fixed rubric reduces ambiguity but does not establish immunity to those failures. Jev is a typed decision model, not a prose generator; see [Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents).
