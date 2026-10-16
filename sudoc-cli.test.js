const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = path.join(__dirname, 'examples/dropdown-sync.sudoc');
const fixture = path.join(__dirname, 'examples/dropdown-sync.fixture.json');

function command(...args) {
    return spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), ...args], { encoding: 'utf8' });
}

function files(action) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sudoc-cli-'));
    try { action(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('compile, inspect, verify, and execute the synthetic dropdown synchronization workflow through the CLI', () => files(directory => {
    const artifact = path.join(directory, 'dropdown-sync.json');
    const compiled = command('compile', source, '--out', artifact);
    assert.equal(compiled.status, 0, compiled.stderr + compiled.stdout);
    assert.equal(command('verify', source, artifact).status, 0);
    const inspection = command('inspect', source, '--json');
    assert.equal(inspection.status, 0, inspection.stderr);
    const plan = JSON.parse(inspection.stdout);
    assert.ok(plan.obligations.some(item => item.kind === 'interpret' && item.boundaries.confidenceThreshold === 0.9));
    assert.equal(plan.obligations.find(item => item.source === 'CHECK portal_matches:').bindings.expected, '100001');
    assert.deepEqual(plan.obligations.find(item => item.kind === 'interpret').branches, ['IF L20 THEN']);
    const fixtureBefore = fs.readFileSync(fixture, 'utf8');
    const result = command('run', source, artifact, '--fixture', fixture);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const run = JSON.parse(result.stdout);
    assert.equal(run.status, 'success');
    assert.equal(run.report.length, 15);
    assert.equal(fs.readFileSync(fixture, 'utf8'), fixtureBefore);
}));

test('run refuses altered artifacts before simulation', () => files(directory => {
    const artifact = path.join(directory, 'tampered.json');
    const compiled = command('compile', source);
    assert.equal(compiled.status, 0, compiled.stderr);
    const data = JSON.parse(compiled.stdout);
    data.program.body.shift();
    fs.writeFileSync(artifact, JSON.stringify(data));
    const result = command('run', source, artifact, '--fixture', fixture);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).valid, false);
    assert.doesNotMatch(result.stdout, /"state"/);
}));

test('CLI rejects accidental writes and ambiguous options', () => files(directory => {
    const copy = path.join(directory, 'workflow.sudoc');
    const original = fs.readFileSync(source, 'utf8');
    fs.writeFileSync(copy, original);
    assert.equal(command('compile', copy, '--out', copy).status, 1);
    assert.equal(fs.readFileSync(copy, 'utf8'), original);
    const alias = path.join(directory, 'alias.json');
    fs.symlinkSync(copy, alias);
    assert.equal(command('compile', copy, '--out', alias).status, 1);
    assert.equal(fs.readFileSync(copy, 'utf8'), original);
    assert.equal(command('run', source, 'artifact', '--fixture', fixture, '--model', 'jev-1.13.0').status, 2);
    assert.equal(command('run', source, 'artifact', '--fixture', fixture, '--fixture', fixture).status, 2);
    assert.equal(command('compile', '-').status, 2);
    assert.equal(command('compile', copy, '--out', '--json').status, 2);
}));

test('new-language editor lint detects unsupported versions and unresolved prose', () => {
    for (const content of ['@WORKFLOW:\n    VERSION 42\n', '@WORKFLOW:\n    VERSION 1\n    ON FAILURE STOP\n    DO whatever seems best\n']) {
        const result = spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), 'lint', '-', '--json'], { input: content, encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.ok(JSON.parse(result.stdout).diagnostics.some(item => item.severity === 'error'));
    }
});


test('invalid JSON never echoes artifact or fixture content', () => files(directory => {
    const invalid = path.join(directory, 'invalid.json');
    fs.writeFileSync(invalid, 'PRIVATE_ADAPTER_TOKEN');
    const verification = command('verify', source, invalid);
    assert.equal(verification.status, 2);
    assert.match(verification.stderr, /invalid JSON/);
    assert.doesNotMatch(verification.stderr, /PRIVATE_ADAPTER_TOKEN|PRIVATE_AD/);
    const artifact = path.join(directory, 'valid.json');
    assert.equal(command('compile', source, '--out', artifact).status, 0);
    const execution = command('run', source, artifact, '--fixture', invalid);
    assert.equal(execution.status, 2);
    assert.doesNotMatch(execution.stderr, /PRIVATE_ADAPTER_TOKEN|PRIVATE_AD/);
}));
