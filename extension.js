const vscode = require('vscode');
const legacy = require('./language');
const sudoc = require('./sudoc-language');

// The version declaration chooses the executable grammar, even when malformed.
const languageFor = source => /^\s*VERSION\b/mi.test(source) ? sudoc : legacy;

const LANGUAGE_ID = 'sudoc';
const SNIPPETS = [
    ['SUDOC WORKFLOW', '@WORKFLOW:\n    VERSION 1\n    ON FAILURE STOP\n    $0', 'Create an executable workflow with an explicit failure policy.'],
    ['VERSION', 'VERSION 1', 'Select Sudoc executable syntax; each operation and freedom boundary must be explicit.'],
    ['INPUT', 'INPUT \\$${1:PORTAL} AS ${2:Number}', 'Declare a typed workflow input.'],
    ['OUTPUT', 'OUTPUT \\$${1:REPORT} AS ${2:List}', 'Declare a typed workflow output.'],
    ['RUN', 'RUN ${1:plan_property} AS \\$${2:PLAN}:\n    WITH ${3:target} = \\$${4:TARGET}', 'Invoke a registered deterministic operation with explicit arguments.'],
    ['CHECK', 'CHECK ${1:portal_matches}:\n    WITH ${2:portal} = \\$${3:PORTAL}\n    WITH ${4:expected} = ${5:100001}', 'Require a registered deterministic check to pass.'],
    ['INTERPRET', 'INTERPRET ${1:label_mapping} AS \\$${2:MAPPING}:\n    QUESTION "${3:Do these conflicting labels mean the same thing?}"\n    USING read_definitions\n    LIMIT 3\n    EVIDENCE property = \\$${4:PLAN}\n    ACCEPT JEV "${5:Approve only if each conflicting value retains the same business meaning.}"\n    CONFIDENCE 0.9\n    ON UNKNOWN REVIEW\n    ON REJECT FAILURE', 'Authorize a bounded agent proposal with separate JEV acceptance and explicit uncertainty handling.'],
    ['PROVIDE', 'PROVIDE \\$${1:REPORT} = \\$${2:RESULT}', 'Bind a declared workflow output.'],
    ['ON FAILURE', 'ON FAILURE STOP', 'Stop later operations after failure and retain partial evidence.'],
    ['@WORKFLOW', '@WORKFLOW:\n    $0', 'Declare the one file-wide workflow object. Its steps are indented.'],
    ['DEFINE', 'DEFINE \\$${1:NAME} AS ${2:description}', 'Give a descriptive value a reusable variable name.'],
    ['FOR EACH', 'FOR EACH \\$${1:RECORD} IN ${2:source}:\n    $0', 'Process records; the loop variable exists only inside this loop.'],
    ['WHERE', 'WHERE ${1:condition}', 'Filter records. Put this first inside FOR EACH.'],
    ['IF', 'IF ${1:condition}:\n    $0', 'Indent the steps to take when the condition is true.'],
    ['ELSE', 'ELSE:\n    $0', 'Alternative branch immediately after IF, at the same indentation.'],
    ['DO', 'DO ${1:action}', 'Describe an action in plain language.'],
    ['THEN', 'THEN ${1:action}', 'Describe the next action; equivalent to DO.'],
    ['USING', 'USING ${1:tool or approach}', 'Describe the tools or working approach.'],
    ['NOTE', 'NOTE ${1:destination and message}', 'Describe what should be recorded and where.'],
    ['STOP RECORD', 'STOP RECORD', 'Stop this record and continue with the next record in the nearest loop.'],
    ['STOP @WORKFLOW', 'STOP @${1:WORKFLOW_NAME}', 'Stop the workflow identified by its file-wide symbol.'],
];

// Translate the shared one-based diagnostic positions to editor ranges.
function updateDiagnostics(document, collection) {
    if (document.languageId !== LANGUAGE_ID) {
        collection.delete(document.uri);
        return;
    }
    const source = document.getText();
    const result = languageFor(source).analyze(source);
    const diagnostics = result.diagnostics.map(item => {
        const lineIndex = item.line - 1;
        const columnIndex = item.column - 1;
        const lineEnd = document.lineAt(lineIndex).text.length;
        const range = new vscode.Range(lineIndex, columnIndex, lineIndex, Math.max(columnIndex + 1, lineEnd));
        let severity = vscode.DiagnosticSeverity.Error;
        if (item.severity === 'warning') {
            severity = vscode.DiagnosticSeverity.Warning;
        }
        const diagnostic = new vscode.Diagnostic(range, item.message, severity);
        diagnostic.code = item.code;
        diagnostic.source = 'Sudoc';
        return diagnostic;
    });
    collection.set(document.uri, diagnostics);
}

// The editor adapter only reads/writes document text. It never runs workflow steps.
function activate(context) {
    const collection = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);
    const output = vscode.window.createOutputChannel('Sudoc');
    output.appendLine('Authoring tools activated. Editing, linting, and formatting never execute workflows.');
    context.subscriptions.push(collection, output);

    for (const document of vscode.workspace.textDocuments) {
        updateDiagnostics(document, collection);
    }
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => updateDiagnostics(document, collection)),
        vscode.workspace.onDidChangeTextDocument(event => updateDiagnostics(event.document, collection)),
        vscode.workspace.onDidCloseTextDocument(document => collection.delete(document.uri)),
        vscode.languages.registerDocumentFormattingEditProvider(LANGUAGE_ID, {
            provideDocumentFormattingEdits(document) {
                try {
                    const source = document.getText();
                    const formatted = languageFor(source).format(source);
                    const range = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
                    return [vscode.TextEdit.replace(range, formatted)];
                } catch (error) {
                    output.appendLine(error.message);
                    return [];
                }
            },
        }),
        vscode.languages.registerCompletionItemProvider(LANGUAGE_ID, {
            provideCompletionItems(document, position) {
                const prefix = document.lineAt(position.line).text.slice(0, position.character);
                if (!/^\s*[A-Za-z ]*$/.test(prefix)) {
                    return [];
                }
                const executable = languageFor(document.getText()) === sudoc;
                const legacyOnly = new Set(['DEFINE', 'WHERE', 'DO', 'THEN', 'NOTE', 'STOP RECORD', 'STOP @WORKFLOW']);
                return SNIPPETS.filter(([label]) => !executable || !legacyOnly.has(label)).map(([label, snippet, explanation]) => {
                    const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
                    const executableSnippets = {
                        'FOR EACH': 'FOR EACH \\$${1:TARGET} IN \\$${2:READY}.targets:\n    $0',
                        IF: 'IF \\$${1:PLAN}.hasConflicts == true:\n    $0',
                        USING: 'USING ${1:read_definitions}',
                    };
                    item.insertText = new vscode.SnippetString(executable ? (executableSnippets[label] || snippet) : snippet);
                    item.documentation = explanation;
                    return item;
                });
            },
        }),
    );
}

module.exports = { activate };
