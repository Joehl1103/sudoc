# Related work and implementation references

Checked 2026-09-18. The user explicitly chose to invent a language as an experiment, even if it converges on SudoLang. These references do not constrain its syntax.

- [SudoLang](https://github.com/paralleldrive/sudolang): natural-language instructions with programming constructs.
- [Third-party SudoLang language server](https://docs.rs/crate/sudolang-lsp/latest): publisher documents deterministic structural diagnostics and formatting. Not installed/tested here.
- [OpenProse linter](https://github.com/openprose/prose-lint): deterministic checking for Markdown-based agent contracts.
- [Gherkin reference](https://cucumber.io/docs/gherkin/reference/): structured behavior scenarios.
- [VS Code language contributions](https://code.visualstudio.com/api/references/contribution-points#contributes.languages): language registration, configuration, and grammar contributions.
- [VS Code programmatic language features](https://code.visualstudio.com/api/language-extensions/programmatic-language-features): diagnostics, completion, and formatting APIs. Integration behavior is exercised locally by editor.test.js.

The examples use hypothetical business rules and non-routable placeholder URLs. No agent classifier or external-service dependency is necessary to lint these documents.
