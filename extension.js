const vscode = require('vscode');
const { analyze, format } = require('./language');
const services = require('./language-services');
const semantic = require('./semantic-review');

const LANGUAGE_ID = 'workflow-experiment';

// Shared service positions are one-based, UTF-16, with exclusive range ends.
function editorRange(document, item) {
    const line = Math.max(0, Math.min(document.lineCount - 1, (item.line || 1) - 1));
    const endLine = Math.max(line, Math.min(document.lineCount - 1, (item.endLine || item.line || 1) - 1));
    const column = Math.max(0, Math.min(document.lineAt(line).text.length, (item.column || 1) - 1));
    const endColumn = Math.max(endLine === line ? column : 0,
        Math.min(document.lineAt(endLine).text.length, (item.endColumn || column + 2) - 1));
    return new vscode.Range(line, column, endLine, endColumn);
}

function publish(document, collection, items, source) {
    const levels = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning,
        information: vscode.DiagnosticSeverity.Information, info: vscode.DiagnosticSeverity.Information,
        hint: vscode.DiagnosticSeverity.Hint };
    collection.set(document.uri, (items || []).map(item => {
        const diagnostic = new vscode.Diagnostic(editorRange(document, item), item.message,
            levels[item.severity] ?? vscode.DiagnosticSeverity.Error);
        diagnostic.code = item.code;
        diagnostic.source = source + (item.category ? ` (${item.category})` : '');
        return diagnostic;
    }));
}

// The editor adapter only reads/writes document text. It never runs workflow steps.
function activate(context) {
    const draft = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);
    const readiness = vscode.languages.createDiagnosticCollection(`${LANGUAGE_ID}-readiness`);
    const meaning = vscode.languages.createDiagnosticCollection(`${LANGUAGE_ID}-semantic`);
    const output = vscode.window.createOutputChannel('Workflow Experiment');
    const reviewRequests = new Map();
    output.appendLine('Authoring tools activated. Workflow execution is not implemented.');
    context.subscriptions.push(draft, readiness, meaning, output);

    function update(document) {
        const key = document.uri.toString();
        reviewRequests.set(key, (reviewRequests.get(key) || 0) + 1);
        meaning.delete(document.uri);
        readiness.delete(document.uri);
        if (document.languageId === LANGUAGE_ID) {
            publish(document, draft, analyze(document.getText()).diagnostics, 'Workflow');
        } else {
            draft.delete(document.uri);
        }
    }
    function activeDocument() {
        const document = vscode.window.activeTextEditor?.document;
        return document?.languageId === LANGUAGE_ID ? document : null;
    }
    for (const document of vscode.workspace.textDocuments) update(document);
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(update),
        vscode.workspace.onDidChangeTextDocument(event => update(event.document)),
        vscode.workspace.onDidCloseTextDocument(document => {
            draft.delete(document.uri);
            readiness.delete(document.uri);
            meaning.delete(document.uri);
            reviewRequests.delete(document.uri.toString());
        }),
        vscode.commands.registerCommand('workflow.check', () => {
            const document = activeDocument();
            if (!document) return;
            const report = analyze(document.getText(), { strict: true });
            publish(document, readiness, report.diagnostics, 'Workflow readiness');
            output.appendLine(`Readiness: ${report.diagnostics.filter(item => item.severity === 'error').length} errors.`);
            return report;
        }),
        vscode.commands.registerCommand('workflow.review', async () => {
            const document = activeDocument();
            if (!document) return;
            const key = document.uri.toString();
            const request = (reviewRequests.get(key) || 0) + 1;
            reviewRequests.set(key, request);
            const version = document.version;
            meaning.delete(document.uri);
            try {
                const report = await semantic.review(document.getText());
                if (document.isClosed || document.version !== version || reviewRequests.get(key) !== request) return;
                publish(document, meaning, report.diagnostics, 'Workflow semantic review');
                const detail = report.reason ? ` (${report.reason})` : '';
                const count = Number.isInteger(report.completedQuestions) ? ` — ${report.completedQuestions}/${report.totalQuestions} questions` : '';
                output.appendLine(`Semantic review: ${report.status}${detail}${count}.`);
                vscode.window.setStatusBarMessage(`Workflow semantic review: ${report.status}${detail}${count}`, 8000);
                return report;
            } catch (error) {
                if (!document.isClosed && document.version === version && reviewRequests.get(key) === request) {
                    output.appendLine('Semantic review unavailable; deterministic checks remain available.');
                    vscode.window.setStatusBarMessage('Workflow semantic review unavailable', 8000);
                }
                return { status: 'unavailable', diagnostics: [] };
            }
        }),
        vscode.commands.registerCommand('workflow.insertTemplate', async name => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== LANGUAGE_ID) return;
            const selected = name || await vscode.window.showQuickPick(services.templateNames(), {
                placeHolder: 'Insert an editable workflow or action template',
            });
            if (!selected) return;
            try {
                const text = services.template(selected);
                const indent = editor.document.lineAt(editor.selection.start.line).text.match(/^\s*/)[0];
                const insertion = text.replace(/\n(?=.)/g, `\n${indent}`);
                return editor.edit(builder => builder.replace(editor.selection, insertion));
            } catch (error) {
                vscode.window.showErrorMessage(`Workflow template: ${error.message}`);
            }
        }),
        vscode.languages.registerDocumentFormattingEditProvider(LANGUAGE_ID, {
            provideDocumentFormattingEdits(document) {
                try {
                    const range = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
                    return [vscode.TextEdit.replace(range, format(document.getText()))];
                } catch (error) {
                    output.appendLine(error.message);
                    return [];
                }
            },
        }),
        vscode.languages.registerCompletionItemProvider(LANGUAGE_ID, {
            provideCompletionItems(document, position) {
                const kinds = { variable: vscode.CompletionItemKind.Variable, field: vscode.CompletionItemKind.Field,
                    action: vscode.CompletionItemKind.Function, function: vscode.CompletionItemKind.Function, enum: vscode.CompletionItemKind.EnumMember, keyword: vscode.CompletionItemKind.Keyword,
                    snippet: vscode.CompletionItemKind.Snippet, type: vscode.CompletionItemKind.Class,
                    value: vscode.CompletionItemKind.Value };
                return services.complete(document.getText(), position.line + 1, position.character + 1).map(entry => {
                    const item = new vscode.CompletionItem(entry.label, kinds[entry.kind] || vscode.CompletionItemKind.Text);
                    item.insertText = entry.snippet ? new vscode.SnippetString(entry.insertText) : entry.insertText;
                    item.range = editorRange(document, entry.range);
                    item.detail = entry.detail;
                    item.documentation = entry.detail;
                    return item;
                });
            },
        }, '$', '.', '@'),
        vscode.languages.registerDefinitionProvider(LANGUAGE_ID, {
            provideDefinition(document, position) {
                const target = services.definition(document.getText(), position.line + 1, position.character + 1);
                return target ? new vscode.Location(document.uri, editorRange(document, target)) : null;
            },
        }),
        vscode.languages.registerHoverProvider(LANGUAGE_ID, {
            provideHover(document, position) {
                const result = services.hover(document.getText(), position.line + 1, position.character + 1);
                return result ? new vscode.Hover(result.contents, editorRange(document, result.range)) : null;
            },
        }),
    );
}

module.exports = { activate };
