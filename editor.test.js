const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

// Poll only while waiting for VS Code's asynchronous document-change events.
async function waitFor(predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error('Timed out waiting for editor diagnostics.');
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

// Executed inside a real extension host, not against a mock of the VS Code API.
async function run() {
    const results = [];
    const reportPath = path.join(__dirname, 'editor-test-results.json');
    try {
        const extension = vscode.extensions.getExtension('local-experiments.workflow-language-experiment');
        assert.ok(extension, 'The extension must be discoverable.');
        await extension.activate();

        const document = await vscode.workspace.openTextDocument({
            language: 'workflow-experiment',
            content: '@WORKFLOW:\n    ELSE:\n        DO inspect\n',
        });
        const editor = await vscode.window.showTextDocument(document);
        await waitFor(() => vscode.languages.getDiagnostics(document.uri).some(item => item.code === 'orphan-else'));
        results.push('Opening a malformed workflow publishes orphan-else diagnostics.');

        const invalidEdits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, { tabSize: 4, insertSpaces: true });
        assert.ok(!invalidEdits || invalidEdits.length === 0, 'Invalid documents must produce no edits.');
        results.push('The formatter refuses malformed indentation/structure.');

        await editor.edit(builder => {
            builder.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), '@workflow:\n  do inspect\n');
        });
        await waitFor(() => vscode.languages.getDiagnostics(document.uri).length === 0);
        results.push('Editing the workflow clears stale diagnostics.');

        const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, { tabSize: 4, insertSpaces: true });
        assert.ok(edits && edits.length > 0, 'A valid unformatted document must produce edits.');
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.set(document.uri, edits);
        assert.equal(await vscode.workspace.applyEdit(workspaceEdit), true);
        assert.equal(document.getText(), '@WORKFLOW:\n    DO inspect\n');
        results.push('Format Document applies canonical indentation and keywords.');

        const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(1, 4));
        assert.ok(completions.items.some(item => item.label === 'IF'));
        assert.ok(completions.items.some(item => item.label === 'DEFINE'));
        results.push('Completion offers workflow snippets.');

        const example = await vscode.workspace.openTextDocument(path.join(__dirname, 'examples/location-sms.workflow'));
        assert.equal(example.languageId, 'workflow-experiment');
        assert.deepEqual(vscode.languages.getDiagnostics(example.uri), []);
        results.push('The .workflow extension selects the language for the full example.');
        const source = '@WORKFLOW:\n    DEFINE $MESSAGE AS the message body\n    DO send $MES\n';
        await editor.edit(builder => builder.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source));
        const variables = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(2, 16));
        const message = variables.items.find(item => item.label === '$MESSAGE');
        assert.ok(message, 'Visible variables must appear in completion.');
        assert.equal(message.range.start.character, 12);
        assert.equal(message.range.end.character, 16);
        results.push('Scoped variable completion supplies a precise replacement range.');

        await editor.edit(builder => builder.replace(new vscode.Range(2, 12, 2, 16), '$MESSAGE'));
        const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, new vscode.Position(2, 15));
        assert.equal(definitions[0].range.start.line, 1);
        const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(2, 15));
        assert.ok(hovers.length > 0);
        results.push('Definitions and hover documentation use the shared symbol model.');

        const services = require('./language-services');
        const sms = services.template('sms');
        const contractDocument = await vscode.workspace.openTextDocument({ language: 'workflow-experiment', content: sms });
        const contractEditor = await vscode.window.showTextDocument(contractDocument);
        const readiness = await vscode.commands.executeCommand('workflow.check');
        assert.equal(readiness.ready, true);
        assert.ok(readiness.diagnostics.every(item => item.severity !== 'error'));
        results.push('The editable SMS template passes strict readiness in the real editor.');

        const completionDocument = await vscode.workspace.openTextDocument({ language: 'workflow-experiment',
            content: '@WORKFLOW:\n    CONTRACT 1\n    INPUT $CUSTOMER AS Customer FROM "customer"\n    NOTE $CUSTOMER.\n' });
        await vscode.window.showTextDocument(completionDocument);
        const fields = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', completionDocument.uri, new vscode.Position(3, 19));
        assert.ok(fields.items.some(item => item.label === 'phone'));
        assert.ok(fields.items.some(item => item.label === 'smsEnabled'));
        results.push('Typed record completion offers catalog fields.');

        // Synthetic in-process reviews verify UI behavior without sending any source to a provider.
        const semantic = require('./semantic-review');
        const originalReview = semantic.review;
        try {
            const pending = [];
            semantic.review = () => new Promise(resolve => pending.push(resolve));
            const reviewEditor = await vscode.window.showTextDocument(contractDocument);
            const concern = message => ({ status: 'reviewed', diagnostics: [{ line: 1, column: 1, endLine: 1, endColumn: 9,
                code: 'semantic-test', category: 'semantic', severity: 'warning', message }] });
            const first = vscode.commands.executeCommand('workflow.review');
            await waitFor(() => pending.length === 1);
            pending[0](concern('A model concern'));
            await first;
            const semanticDiagnostic = vscode.languages.getDiagnostics(contractDocument.uri).find(item => item.code === 'semantic-test');
            assert.ok(semanticDiagnostic.source.includes('semantic'));
            assert.equal(semanticDiagnostic.range.end.character, 8);
            results.push('Model concerns are separately identified and preserve precise ranges.');

            const stale = vscode.commands.executeCommand('workflow.review');
            await waitFor(() => pending.length === 2);
            await reviewEditor.edit(builder => builder.insert(new vscode.Position(0, 0), '# edited\n'));
            pending[1](concern('Stale concern'));
            await stale;
            assert.ok(!vscode.languages.getDiagnostics(contractDocument.uri).some(item => item.code === 'semantic-test'));
            results.push('Editing invalidates pending and displayed semantic findings.');

            const older = vscode.commands.executeCommand('workflow.review');
            const newer = vscode.commands.executeCommand('workflow.review');
            await waitFor(() => pending.length === 4);
            pending[3](concern('Newer concern'));
            await newer;
            pending[2](concern('Older concern'));
            await older;
            assert.equal(vscode.languages.getDiagnostics(contractDocument.uri).find(item => item.code === 'semantic-test').message, 'Newer concern');
            results.push('Late reviews cannot replace a newer review for the same document.');

            semantic.review = async () => ({ status: 'unavailable', diagnostics: [] });
            assert.equal((await vscode.commands.executeCommand('workflow.review')).status, 'unavailable');
            assert.ok(!vscode.languages.getDiagnostics(contractDocument.uri).some(item => item.code === 'semantic-test'));
            results.push('Unavailable semantic review stays visibly distinct from a completed review.');
        } finally {
            semantic.review = originalReview;
        }

        const blank = await vscode.workspace.openTextDocument({ language: 'workflow-experiment', content: '' });
        await vscode.window.showTextDocument(blank);
        assert.equal(await vscode.commands.executeCommand('workflow.insertTemplate', 'sms'), true);
        assert.equal(blank.getText(), sms);
        results.push('Template insertion produces ordinary editable workflow source.');
        fs.writeFileSync(reportPath, JSON.stringify({ passed: true, results }, null, 2) + '\n');
    } catch (error) {
        fs.writeFileSync(reportPath, JSON.stringify({ passed: false, results, error: error.stack }, null, 2) + '\n');
        throw error;
    }
}

module.exports = { run };
