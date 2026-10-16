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
        const extension = vscode.extensions.getExtension('local-experiments.sudoc');
        assert.ok(extension, 'The extension must be discoverable.');
        await extension.activate();

        const document = await vscode.workspace.openTextDocument({
            language: 'sudoc',
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
        assert.equal(example.languageId, 'sudoc');
        assert.deepEqual(vscode.languages.getDiagnostics(example.uri), []);
        results.push('The .workflow extension selects the language for the full example.');
        const sudocExample = await vscode.workspace.openTextDocument(path.join(__dirname, 'examples/dropdown-sync.sudoc'));
        assert.equal(sudocExample.languageId, 'sudoc');
        assert.deepEqual(vscode.languages.getDiagnostics(sudocExample.uri), []);
        results.push('The .sudoc extension selects the language for the executable example.');

        const executable = await vscode.workspace.openTextDocument({
            language: 'sudoc',
            content: '@WORKFLOW:\n    VERSION 1\n    ON FAILURE STOP\n    DO improvise\n',
        });
        const executableEditor = await vscode.window.showTextDocument(executable);
        await waitFor(() => vscode.languages.getDiagnostics(executable.uri).some(item => item.range.start.line === 3));
        results.push('Executable grammar diagnoses unauthorized prose in an unsaved document.');
        const rejectedEdits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', executable.uri, { tabSize: 4, insertSpaces: true });
        assert.ok(!rejectedEdits || rejectedEdits.length === 0);

        await executableEditor.edit(builder => {
            builder.replace(new vscode.Range(executable.positionAt(0), executable.positionAt(executable.getText().length)),
                '@WORKFLOW:\n  VERSION 1\n  INPUT $PORTAL AS Number\n  ON FAILURE STOP\n  CHECK portal_matches:\n    WITH portal = $PORTAL\n    WITH expected = 100001\n');
        });
        await waitFor(() => vscode.languages.getDiagnostics(executable.uri).length === 0);
        const sudocEdits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', executable.uri, { tabSize: 4, insertSpaces: true });
        assert.ok(sudocEdits && sudocEdits.length > 0);
        const sudocEdit = new vscode.WorkspaceEdit();
        sudocEdit.set(executable.uri, sudocEdits);
        assert.equal(await vscode.workspace.applyEdit(sudocEdit), true);
        assert.match(executable.getText(), /\n    CHECK portal_matches:\n        WITH portal = \$PORTAL/);
        results.push('Executable formatting and live diagnostic clearing use the Sudoc parser.');

        const sudocCompletions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', executable.uri, new vscode.Position(4, 4));
        for (const label of ['RUN', 'CHECK', 'INTERPRET', 'PROVIDE']) {
            assert.ok(sudocCompletions.items.some(item => item.label === label));
        }
        assert.ok(!sudocCompletions.items.some(item => item.label === 'DO'));
        const inputSnippet = sudocCompletions.items.find(item => item.label === 'INPUT');
        assert.match(inputSnippet.insertText.value, /\\\$/);
        results.push('Executable completion offers boundaries and checks, with escaped variable sigils.');

        await executableEditor.edit(builder => {
            builder.replace(new vscode.Range(executable.positionAt(0), executable.positionAt(executable.getText().length)),
                '@WORKFLOW:\n    VERSION 2\n    ON FAILURE STOP\n    DO improvise\n');
        });
        await waitFor(() => vscode.languages.getDiagnostics(executable.uri).some(item => item.range.start.line === 1));
        results.push('Unsupported versions remain in the executable grammar and report errors.');
        fs.writeFileSync(reportPath, JSON.stringify({ passed: true, results }, null, 2) + '\n');
    } catch (error) {
        fs.writeFileSync(reportPath, JSON.stringify({ passed: false, results, error: error.stack }, null, 2) + '\n');
        throw error;
    }
}

module.exports = { run };
