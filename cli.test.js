const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { editorArguments } = require('./open-editor');

// Exercise the real CLI against isolated files, including failed write attempts.
function withFixture(source, action) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-cli-'));
    const filename = path.join(directory, 'example.workflow');
    fs.writeFileSync(filename, source);
    try {
        action(filename);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function run(...argumentsList) {
    return spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), ...argumentsList], { encoding: 'utf8' });
}

describe('Command line authoring', () => {
    test('lints unsaved editor text from stdin as structured diagnostics', () => {
        const result = spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), 'lint', '-', '--json'], {
            input: '@WORKFLOW:\n    ELSE:\n        DO inspect\n',
            encoding: 'utf8',
        });
        assert.equal(result.status, 1);
        const report = JSON.parse(result.stdout);
        assert.ok(report.diagnostics.some(item => item.code === 'orphan-else' && item.line === 2));
    });

    test('formats stdin and rejects attempts to write back to stdin', () => {
        const argumentsList = [path.join(__dirname, 'cli.js'), 'format', '-'];
        const result = spawnSync(process.execPath, argumentsList, {
            input: '@workflow:\n  do inspect\n',
            encoding: 'utf8',
        });
        assert.equal(result.status, 0);
        assert.equal(result.stdout, '@WORKFLOW:\n    DO inspect\n');
        assert.equal(run('format', '-', '--write').status, 2);
    });

    test('launches the editor with absolute paths independent of its working directory', () => {
        const argumentsList = editorArguments(__dirname);
        assert.ok(argumentsList.includes('lua dofile(vim.env.WORKFLOW_EXPERIMENT_PLUGIN)'));
        assert.ok(argumentsList.includes(path.join(__dirname, 'examples/location-sms.workflow')));
        assert.ok(argumentsList.includes('-c'));
    });

    test('reports line numbers and fails lint on invalid structure', () => {
        withFixture('@WORKFLOW:\n    ELSE:\n        DO inspect\n', filename => {
            const result = run('lint', filename);
            assert.equal(result.status, 1);
            assert.match(result.stdout, /:2:5.*orphan-else/);
        });
    });

    test('formats to stdout by default and writes only with --write', () => {
        const original = '@workflow:\n  do inspect\n';
        withFixture(original, filename => {
            const preview = run('format', filename);
            assert.equal(preview.status, 0);
            assert.equal(fs.readFileSync(filename, 'utf8'), original);
            assert.equal(preview.stdout, '@WORKFLOW:\n    DO inspect\n');
            assert.equal(run('format', filename, '--write').status, 0);
            assert.equal(fs.readFileSync(filename, 'utf8'), preview.stdout);
        });
    });

    test('does not modify invalid files', () => {
        const original = '@WORKFLOW:\n    IF ready:\n';
        withFixture(original, filename => {
            assert.equal(run('format', filename, '--write').status, 1);
            assert.equal(fs.readFileSync(filename, 'utf8'), original);
        });
    });

    test('fails with usage errors for absent files and unknown options', () => {
        assert.equal(run('lint').status, 2);
        assert.equal(run('lint', '/nonexistent/example.workflow').status, 2);
        assert.equal(run('format', 'example.workflow', '--mystery').status, 2);
    });
});

describe('Contract CLI services', () => {
    const example = path.join(__dirname, 'examples', 'sms-contract.workflow');
    function input(command, source, ...options) {
        return spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), command, '-', ...options], {
            input: source, encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' },
        });
    }

    test('strict check accepts the complete example and explicitly refuses a legacy document', () => {
        const valid = run('check', example, '--json');
        assert.equal(valid.status, 0, valid.stderr);
        assert.deepEqual(JSON.parse(valid.stdout), { mode: 'contract', ready: true, diagnostics: [] });
        const legacy = input('check', '@WORKFLOW:\n    DO inspect\n', '--json');
        assert.equal(legacy.status, 1);
        assert.ok(JSON.parse(legacy.stdout).diagnostics.some(item => item.code === 'contract-required'));
    });

    test('templates print visible source and incomplete drafts fail readiness', () => {
        const draft = run('template', 'workflow');
        assert.equal(draft.status, 0);
        assert.match(draft.stdout, /INPUT \$SOURCE AS Text FROM \?/);
        assert.equal(input('lint', draft.stdout, '--json').status, 0);
        assert.equal(input('check', draft.stdout, '--json').status, 1);
        assert.equal(run('template', 'not-a-template').status, 2);
    });

    test('shared completion and navigation commands return JSON using one-based positions', () => {
        const source = '@WORKFLOW:\n    DEFINE $SOURCE AS rows\n    NOTE $SOURCE\n';
        const result = input('complete', source, '--line', '3', '--column', '11', '--json');
        assert.equal(result.status, 0, result.stderr);
        assert.ok(JSON.parse(result.stdout).some(item => item.label === '$SOURCE'));
        const target = input('definition', source, '--line', '3', '--column', '12', '--json');
        assert.equal(target.status, 0);
        assert.equal(JSON.parse(target.stdout).line, 2);
        const hover = input('hover', source, '--line', '3', '--column', '12', '--json');
        assert.match(JSON.parse(hover.stdout).contents, /\$SOURCE/);
    });

    test('review without credentials is explicitly unreviewed and makes no provider request', () => {
        const result = input('review', fs.readFileSync(example, 'utf8'), '--json');
        assert.equal(result.status, 2);
        const report = JSON.parse(result.stdout);
        assert.equal(report.status, 'unreviewed');
        assert.equal(report.reason, 'missing-credentials');
        assert.equal(report.completedQuestions, 0);
    });

    test('CLI loads a data-only catalog and rejects malformed catalog contracts', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-catalog-'));
        const catalog = path.join(directory, 'catalog.json');
        try {
            fs.writeFileSync(catalog, JSON.stringify({ types: { Ticket: { fields: { description: 'Text' } } } }));
            const source = '@WORKFLOW:\n    CONTRACT 1\n    INPUT $TICKET AS Ticket FROM "request.ticket"\n    OUTPUT $TEXT AS Text\n    CONDITION $READY AS true\n    PROVIDE $TEXT = $TICKET.description\n    EXIT SUCCESS\n';
            assert.equal(input('check', source, '--catalog', catalog, '--json').status, 0);
            fs.writeFileSync(catalog, '{"actions":{"send_sms":{}}}');
            const invalid = input('check', source, '--catalog', catalog, '--json');
            assert.equal(invalid.status, 2);
            assert.match(invalid.stderr, /Invalid domain catalog/);
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });

    test('position and command-specific options are validated before reading a file', () => {
        for (const args of [
            ['complete', example, '--line', '0', '--column', '1'],
            ['definition', example, '--line', '1'],
            ['hover', example, '--line', '1', '--column', '1', '--column', '2'],
            ['check', example, '--write'], ['review', example, '--write'],
            ['template', 'sms', '--json'], ['lint', example, '--model', 'jev-latest'],
        ]) assert.equal(run(...args).status, 2, args.join(' '));
    });
});
