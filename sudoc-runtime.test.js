'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compile } = require('./sudoc-compiler');
const { run } = require('./sudoc-runtime');

const source = fs.readFileSync(path.join(__dirname, 'examples/dropdown-sync.sudoc'), 'utf8');
const fixtureText = fs.readFileSync(path.join(__dirname, 'examples/dropdown-sync.fixture.json'), 'utf8');
const fresh = () => JSON.parse(fixtureText);
const execute = (fixture = fresh(), options = {}, code = source) => run(code, compile(code), { fixture, ...options });
const writes = result => result.trace.filter(item => item.kind === 'write');

test('dropdown synchronization simulation preserves definitions, completes all 15 targets, and separates proposal from acceptance', async () => {
    const fixture = fresh();
    fixture.objects.calls.untouched = { important: 'preserve this unrelated property' };
    const original = structuredClone(fixture);
    const result = await execute(fixture);
    assert.equal(result.status, 'success', JSON.stringify(result.error));
    assert.deepEqual(fixture, original, 'simulation never changes the caller fixture');
    assert.equal(result.report.length, 15);
    assert.equal(result.report.filter(item => item.status === 'created').length, 12);
    assert.equal(result.report.filter(item => item.status === 'updated').length, 2);
    assert.equal(result.report.filter(item => item.status === 'unchanged').length, 1);
    assert.deepEqual(result.outputs.$REPORT, result.report);
    assert.deepEqual(result.state.objects.calls.rep_branch.options, [
        { value: 'north', label: 'Northern' }, { value: 'legacy', label: 'Legacy' }, { value: 'south', label: 'South' },
    ]);
    assert.deepEqual(result.state.objects.calls.untouched, original.objects.calls.untouched);
    assert.deepEqual(result.state.objects.meetings.rep_division, original.objects.meetings.rep_division);
    assert.deepEqual(result.state.objects.deals.rep_branch.options, original.sourceProperties.branch.options);
    assert.equal(result.trace.filter(item => item.kind === 'read-back').length, 15);
    const proposal = result.trace.findIndex(item => item.kind === 'proposal');
    const judgment = result.trace.findIndex(item => item.kind === 'judgment');
    const write = result.trace.findIndex(item => item.kind === 'write');
    assert.ok(proposal < judgment && judgment < write);
    assert.equal(result.trace[proposal].simulation, true);
    assert.equal(result.trace[judgment].simulation, true);
});

test('tampered compiled artifact is rejected before any adapter or operation', async () => {
    const artifact = compile(source);
    artifact.program.body[0].args.expected.value = 42;
    let calls = 0;
    const result = await run(source, artifact, { fixture: fresh(), agent: () => { calls++; }, judge: () => { calls++; } });
    assert.equal(result.status, 'failure');
    assert.equal(result.error.code, 'artifact-invalid');
    assert.equal(calls, 0);
    assert.deepEqual(writes(result), []);
    assert.equal(result.trace.length, 1);
});

test('all source definitions are validated before the first write', async () => {
    const fixture = fresh();
    delete fixture.sourceProperties.region;
    const result = await execute(fixture);
    assert.equal(result.status, 'failure');
    assert.equal(result.error.code, 'missing-source');
    assert.equal(writes(result).length, 0);
    assert.equal(result.report.length, 15);
    assert.ok(result.report.every(item => item.status === 'not_attempted'));
    assert.deepEqual(result.state.objects, fixture.objects);
});

test('wrong authenticated portal fails before changes with a complete not-attempted report', async () => {
    const fixture = fresh();
    fixture.portal = 42;
    const result = await execute(fixture);
    assert.equal(result.error.code, 'portal-mismatch');
    assert.equal(writes(result).length, 0);
    assert.equal(result.report.length, 15);
    assert.ok(result.report.every(item => item.status === 'not_attempted'));
});

test('invalid and duplicate source option values fail preflight', async () => {
    const fixture = fresh();
    fixture.sourceProperties.region.options.push({ value: 'central', label: 'Other Central' });
    const result = await execute(fixture);
    assert.equal(result.error.code, 'invalid-options');
    assert.equal(writes(result).length, 0);
});

test('a label conflict without author-granted interpretation cannot be applied', async () => {
    const code = source.replace(/        IF \$PLAN.hasConflicts == true:\n[\s\S]*?(?=        RUN apply_property)/, '');
    const result = await execute(fresh(), {}, code);
    assert.equal(result.status, 'failure');
    assert.equal(result.error.code, 'interpretation-required');
    assert.equal(writes(result).length, 0);
});

test('missing preservation check cannot be silently replaced by an agent assertion', async () => {
    const code = source.replace('        CHECK preserve_existing:\n            WITH plan = $PLAN\n', '');
    const result = await execute(fresh(), {}, code);
    assert.equal(result.error.code, 'preservation-required');
    assert.equal(writes(result).length, 0);
});

test('failed read-back stops subsequent writes and preserves an accurate partial report', async () => {
    const fixture = fresh();
    fixture.faults = { readbackMismatch: 'deals/rep_branch' };
    const result = await execute(fixture);
    assert.equal(result.status, 'failure');
    assert.equal(result.error.code, 'readback-mismatch');
    assert.deepEqual(result.report.slice(0, 4).map(item => item.status), ['updated', 'created', 'failed', 'not_attempted']);
    assert.equal(result.report.length, 15);
    assert.equal(writes(result).length, 3);
    assert.equal(result.state.objects.calls.rep_division, undefined);
});

test('write failure records current failure and all later targets as not_attempted', async () => {
    const fixture = fresh();
    fixture.faults = { writeFailure: 'meetings/rep_branch' };
    const result = await execute(fixture);
    assert.equal(result.error.code, 'write-failed');
    assert.equal(writes(result).length, 1);
    assert.deepEqual(result.report.slice(0, 3).map(item => item.status), ['updated', 'failed', 'not_attempted']);
    assert.equal(result.state.objects.meetings.rep_branch, undefined);
});

test('omitting read-back verification prevents subsequent writes and success', async () => {
    const code = source.replace('        CHECK matches_expected:\n            WITH actual = $ACTUAL\n            WITH expected = $PLAN.expected\n', '');
    const result = await execute(fresh(), {}, code);
    assert.equal(result.status, 'failure');
    assert.equal(result.error.code, 'verification-required');
    assert.equal(writes(result).length, 1);
});

test('using a forged literal instead of a fresh read cannot satisfy read-back verification', async () => {
    const code = source.replace('WITH actual = $ACTUAL', 'WITH actual = $PLAN.expected');
    const result = await execute(fresh(), {}, code);
    assert.equal(result.error.code, 'unbound-readback');
    assert.equal(writes(result).length, 1);
});

test('independent rejection cannot be overridden by an accepting agent proposal', async () => {
    const result = await execute(fresh(), { judge: async () => ({ outcome: 'reject', confidence: 0.99 }) });
    assert.equal(result.status, 'failure');
    assert.equal(result.error.code, 'interpretation-rejected');
    assert.equal(writes(result).length, 0);
});

test('unknown, low-confidence, malformed, and inconsistent judgments require review', async t => {
    for (const judgment of [
        { outcome: 'unknown', confidence: 0.99 },
        { outcome: 'accept', confidence: 0.5 },
        { outcome: 'yes', confidence: 1 },
        { outcome: 'accept', confidence: Number.NaN },
        { outcome: 'accept', confidence: 0.99, probabilities: { accept: 0.8, reject: 0.3, unknown: 0 } },
        { outcome: 'accept', confidence: 0.99, probabilities: { accept: 0.1, reject: 0.8, unknown: 0.1 } },
    ]) await t.test(JSON.stringify(judgment), async () => {
        const result = await execute(fresh(), { judge: async () => judgment });
        assert.equal(result.status, 'review');
        assert.equal(writes(result).length, 0);
        assert.equal(result.report.length, 15);
    });
});

test('evaluator confidence may differ from its winning outcome probability', async () => {
    const result = await execute(fresh(), { judge: async () => ({ outcome: 'accept', confidence: 0.94, probabilities: { accept: 0.98, reject: 0.01, unknown: 0.01 } }) });
    assert.equal(result.status, 'success');
});

test('missing fixture judgment defaults to explicit review, never acceptance', async () => {
    const fixture = fresh();
    fixture.judgments = {};
    const result = await execute(fixture);
    assert.equal(result.status, 'review');
    assert.equal(result.error.code, 'uncertain-judgment');
    assert.equal(writes(result).length, 0);
});

test('agent cannot add runtime changes or alter original conflict evidence', async t => {
    for (const mutate of [
        proposal => { proposal.approved = true; },
        proposal => { proposal.mappings[0].sourceLabel = 'Different'; },
        proposal => { proposal.mappings.push(proposal.mappings[0]); },
        proposal => { proposal.equivalent = false; },
    ]) await t.test(String(mutate), async () => {
        const fixture = fresh();
        mutate(fixture.proposals['calls/rep_branch']);
        let judgments = 0;
        const result = await execute(fixture, { judge: async () => { judgments++; return { outcome: 'accept', confidence: 1 }; } });
        assert.equal(result.status, 'review');
        assert.equal(result.error.code, 'invalid-proposal');
        assert.equal(judgments, 0);
        assert.equal(writes(result).length, 0);
    });
});

test('capability budget exhaustion remains fatal to the interpretation even if the adapter catches it', async () => {
    const fixture = fresh();
    const result = await execute(fixture, { agent: async request => {
        assert.deepEqual(Object.keys(request.tools), ['read_definitions']);
        assert.ok(Object.isFrozen(request.evidence.property));
        await request.tools.read_definitions();
        await request.tools.read_definitions();
        await assert.rejects(request.tools.read_definitions(), /budget/);
        return fixture.proposals['calls/rep_branch'];
    } });
    assert.equal(result.status, 'review');
    assert.equal(result.error.code, 'interpretation-budget');
    assert.equal(writes(result).length, 0);
});

test('agent capability is revoked after timeout', async () => {
    let capability;
    let aborted;
    const result = await execute(fresh(), { adapterTimeoutMs: 5, agent: async request => {
        capability = request.tools.read_definitions;
        aborted = request.signal;
        return new Promise(() => {});
    } });
    assert.equal(result.status, 'review');
    assert.equal(result.error.code, 'adapter-timeout');
    assert.equal(aborted.aborted, true);
    await assert.rejects(capability(), /expired/);
    assert.equal(writes(result).length, 0);
});

test('judge timeout also cannot approve a proposal', async () => {
    const result = await execute(fresh(), { adapterTimeoutMs: 5, judge: async () => new Promise(() => {}) });
    assert.equal(result.status, 'review');
    assert.equal(result.error.code, 'adapter-timeout');
    assert.equal(writes(result).length, 0);
});

test('global step budget stops before writes', async () => {
    const result = await execute(fresh(), { maxSteps: 3 });
    assert.equal(result.status, 'failure');
    assert.equal(result.error.code, 'step-budget');
    assert.equal(writes(result).length, 0);
});

test('typed inputs reject mismatches and Text values run without a fixture', async () => {
    const invalid = await execute(fresh(), { inputs: { $PORTAL: '100001' } });
    assert.equal(invalid.error.code, 'invalid-input');
    const code = '@WORKFLOW:\n    VERSION 1\n    INPUT $TEXT AS Text\n    OUTPUT $RESULT AS Text\n    ON FAILURE STOP\n    PROVIDE $RESULT = $TEXT\n';
    const result = await run(code, compile(code), { inputs: { $TEXT: 'sudoc' } });
    assert.equal(result.status, 'success');
    assert.deepEqual(result.outputs, { $RESULT: 'sudoc' });
});

test('execution uses its verified artifact snapshot even when an adapter mutates the caller artifact', async () => {
    const fixture = fresh();
    const artifact = compile(source);
    const result = await run(source, artifact, { fixture, agent: async () => {
        const loop = artifact.program.body.find(node => node.kind === 'for');
        loop.body.push({ kind: 'unverified-external-instruction' });
        artifact.program.body.push({ kind: 'unverified-external-instruction' });
        return fixture.proposals['calls/rep_branch'];
    } });
    assert.equal(result.status, 'success');
    assert.equal(result.report.length, 15);
    assert.equal(result.trace.some(event => event.kind === 'unverified-external-instruction'), false);
});

test('a proposal cannot change after the evaluator has received its evidence snapshot', async () => {
    const fixture = fresh();
    const mutable = structuredClone(fixture.proposals['calls/rep_branch']);
    const result = await execute(fixture, {
        agent: async () => mutable,
        judge: async request => {
            mutable.equivalent = false;
            mutable.mappings[0].existingLabel = 'Altered after validation';
            assert.equal(request.proposal.equivalent, true);
            assert.equal(request.proposal.mappings[0].existingLabel, 'Northern');
            return { outcome: 'accept', confidence: 1 };
        },
    });
    assert.equal(result.status, 'success');
    const proposal = result.trace.find(event => event.kind === 'proposal').proposal;
    assert.equal(proposal.equivalent, true);
    assert.equal(proposal.mappings[0].existingLabel, 'Northern');
    assert.equal(result.state.objects.calls.rep_branch.options[0].label, 'Northern');
});

test('adapter exceptions and non-cloneable results become review without leaking their messages', async t => {
    for (const name of ['agent', 'judge']) for (const nonCloneable of [false, true]) {
        await t.test(`${name} ${nonCloneable ? 'result' : 'exception'}`, async () => {
            const result = await execute(fresh(), { [name]: async () => {
                if (nonCloneable) return { accidental_secret: () => 'api-secret-do-not-log' };
                throw new Error('api-secret-do-not-log');
            } });
            assert.equal(result.status, 'review');
            assert.equal(result.error.code, 'adapter-failed');
            assert.equal(JSON.stringify(result).includes('api-secret-do-not-log'), false);
            assert.equal(writes(result).length, 0);
        });
    }
});

test('agent cannot suppress global budget exhaustion inside a capability request', async () => {
    const fixture = fresh();
    let judges = 0;
    const result = await execute(fixture, { maxSteps: 7, agent: async request => {
        await assert.rejects(request.tools.read_definitions(), /step budget/);
        return fixture.proposals['calls/rep_branch'];
    }, judge: async () => { judges++; return { outcome: 'accept', confidence: 1 }; } });
    assert.equal(result.status, 'failure');
    assert.equal(result.error.code, 'step-budget');
    assert.equal(judges, 0);
    assert.equal(writes(result).length, 0);
});

test('direct runtime inputs and fixtures reject non-JSON data before operations', async t => {
    const cyclic = {};
    cyclic.self = cyclic;
    const cases = {
        Date: new Date('2026-01-01'),
        Map: new Map([['key', 'value']]),
        nonfinite: { nested: [Number.NaN] },
        undefined: { nested: [undefined] },
        negativeZero: { nested: [-0] },
        cyclic,
    };
    for (const [name, value] of Object.entries(cases)) for (const field of ['inputs', 'fixture']) {
        await t.test(`${field}: ${name}`, async () => {
            const result = await execute(fresh(), { [field]: field === 'inputs' ? { $PORTAL: value } : value });
            assert.equal(result.status, 'failure');
            assert.equal(result.error.code, 'invalid-data');
            assert.equal(writes(result).length, 0);
            assert.equal(result.trace.some(item => item.kind === 'action'), false);
        });
    }
});

test('direct runtime accepts JSON lists with nested records and null', async () => {
    const code = '@WORKFLOW:\n    VERSION 1\n    INPUT $ITEMS AS List\n    OUTPUT $RESULT AS List\n    ON FAILURE STOP\n    PROVIDE $RESULT = $ITEMS\n';
    const items = [1, { text: 'sudoc', flags: [true, false] }, null];
    const result = await run(code, compile(code), { inputs: { $ITEMS: items } });
    assert.equal(result.status, 'success');
    assert.deepEqual(result.outputs.$RESULT, items);
});
