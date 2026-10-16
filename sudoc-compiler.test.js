'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, format } = require('./sudoc-language');
const { compile, verify, canonical, contractHash } = require('./sudoc-compiler');

function workflow(...body) {
    return ['@WORKFLOW:', '    VERSION 1', '    ON FAILURE STOP', ...body].join('\n') + '\n';
}

function codes(source) {
    return analyze(source).diagnostics.map(item => item.code);
}

const deterministic = workflow(
    '    INPUT $PORTAL AS Number',
    '    OUTPUT $REPORT AS List',
    '    CHECK portal_matches:',
    '        WITH portal = $PORTAL',
    '        WITH expected = 100001',
    '    RUN preflight AS $PREFLIGHT:',
    '        WITH portal = $PORTAL',
    '        WITH properties = ["branch", "region"]',
    '        WITH objects = ["calls", "deals"]',
    '    FOR EACH $TARGET IN $PREFLIGHT.targets:',
    '        RUN plan_property AS $PLAN:',
    '            WITH target = $TARGET',
    '        CHECK preserve_existing:',
    '            WITH plan = $PLAN',
    '        RUN apply_property AS $APPLIED:',
    '            WITH plan = $PLAN',
    '        RUN read_property AS $ACTUAL:',
    '            WITH target = $TARGET',
    '        CHECK matches_expected:',
    '            WITH actual = $ACTUAL',
    '            WITH expected = $PLAN.expected',
    '    RUN build_report AS $ROWS:',
    '    PROVIDE $REPORT = $ROWS',
);

const interpretation = workflow(
    '    INPUT $PLAN AS Record',
    '    OUTPUT $RESULT AS Record',
    '    INTERPRET label_mapping AS $MAPPING:',
    '        QUESTION "Do these labels have the same business meaning?"',
    '        USING read_definitions',
    '        LIMIT 3',
    '        EVIDENCE property = $PLAN',
    '        ACCEPT JEV "Accept only if meaning and option values are preserved."',
    '        CONFIDENCE 0.9',
    '        ON UNKNOWN REVIEW',
    '        ON REJECT FAILURE',
    '    PROVIDE $RESULT = $MAPPING',
);

describe('Sudoc executable grammar', () => {
    test('compiles deterministic registered operations with source locations', () => {
        assert.deepEqual(codes(deterministic), []);
        const artifact = compile(deterministic);
        assert.equal(artifact.format, 'sudoc-ir');
        assert.equal(artifact.version, 1);
        assert.equal(artifact.program.failure, 'stop');
        assert.deepEqual(artifact.program.inputs[0], { name: '$PORTAL', type: 'Number', source: { line: 4, column: 5 } });
        assert.deepEqual(artifact.program.body[2].items, { kind: 'ref', name: '$PREFLIGHT', path: ['targets'] });
        assert.deepEqual(verify(deterministic, artifact), { valid: true, diagnostics: [] });
    });

    test('preserves all explicit interpretation boundaries', () => {
        const node = compile(interpretation).program.body[0];
        assert.equal(node.kind, 'interpret');
        assert.equal(node.decision, 'label_mapping');
        assert.equal(node.out, '$MAPPING');
        assert.deepEqual(node.capabilities, ['read_definitions']);
        assert.equal(node.budget, 3);
        assert.equal(node.confidence, 0.9);
        assert.equal(node.onUnknown, 'review');
        assert.equal(node.onReject, 'failure');
        assert.equal(node.evidence.property.name, '$PLAN');
        assert.ok(node.rubric.includes('option values'));
    });

    test('normalizes consistent indentation to four spaces and preserves comments', () => {
        const two = deterministic.replace(/^ +/gm, spaces => spaces.slice(0, spaces.length / 2));
        assert.deepEqual(codes(two), []);
        assert.equal(format(two), deterministic);
        assert.equal(format(deterministic + '    # Keep the report\n'), deterministic + '    # Keep the report\n');
    });

    test('requires one unindented workflow header and an explicit version', () => {
        assert.ok(codes('').includes('workflow-required'));
        assert.ok(codes(deterministic.replace('@WORKFLOW:', '@DEMO:')).includes('workflow-required'));
        assert.ok(codes(deterministic + deterministic).includes('workflow-required'));
        assert.ok(codes(deterministic.replace('    VERSION 1\n', '')).includes('version-required'));
        assert.ok(codes(deterministic.replace('VERSION 1', 'VERSION 2')).includes('unsupported-version'));
        assert.ok(codes(deterministic.replace('    ON FAILURE STOP\n', '')).includes('failure-policy-required'));
    });

    test('rejects tabs and inconsistent indentation', () => {
        assert.ok(codes(deterministic.replace('    INPUT', '\tINPUT')).includes('tabs'));
        assert.ok(codes(deterministic.replace('        WITH portal', '      WITH portal')).includes('inconsistent-indent'));
        assert.throws(() => format(deterministic.replace('    INPUT', '\tINPUT')), /Fix sudoc diagnostics/);
    });

    test('rejects prose, unknown actions, checks, arguments, and capabilities', () => {
        assert.ok(codes(workflow('    DO whatever is best')).includes('unknown-statement'));
        assert.ok(codes(workflow('    RUN arbitrary_code:')).includes('unknown-action'));
        assert.ok(codes(workflow('    CHECK looks_good:')).includes('unknown-check'));
        assert.ok(codes(deterministic.replace('WITH portal = $PORTAL', 'WITH nonsense = $PORTAL')).includes('unknown-argument'));
        assert.ok(codes(deterministic.replace('        WITH expected = 100001\n', '')).includes('missing-argument'));
        assert.ok(codes(deterministic.replace('        WITH expected = 100001', '        WITH expected = 100001\n        WITH expected = 1')).includes('duplicate-argument'));
        assert.ok(codes(interpretation.replace('USING read_definitions', 'USING unrestricted_shell')).includes('unknown-capability'));
    });

    test('does not allow undeclared variables or imperative expressions', () => {
        assert.ok(codes(deterministic.replace('WITH portal = $PORTAL', 'WITH portal = $MISSING')).includes('undefined-variable'));
        assert.ok(codes(deterministic.replace('WITH portal = $PORTAL', 'WITH portal = process.env.PORTAL')).includes('invalid-expression'));
        assert.ok(codes(deterministic.replace('WITH portal = $PORTAL', 'WITH portal = $portal')).includes('invalid-expression'));
        assert.ok(codes(deterministic.replace('WITH portal = $PORTAL', 'WITH portal = 1e999')).includes('invalid-expression'));
        assert.ok(codes(deterministic.replace('WITH portal = $PORTAL', 'WITH portal = $PORTAL.constructor')).includes('reserved-field'));
    });

    test('rejects duplicate JSON keys rather than silently choosing an interpretation', () => {
        const source = literal => workflow('    OUTPUT $RESULT AS Record', `    PROVIDE $RESULT = ${literal}`);
        for (const literal of ['{"a": 1, "a": 2}', '{"nested": [{"a": 1, "a": 2}]}', '{"a": 1, "\\u0061": 2}', '{"__proto__": 1, "__proto__": 2}']) {
            assert.ok(codes(source(literal)).includes('duplicate-json-key'), literal);
            assert.throws(() => compile(source(literal)), /repeated/);
        }
        assert.deepEqual(codes(source('{"left": {"a": 1}, "right": {"a": 2}}')), []);
        assert.deepEqual(codes(source('{"__proto__": {"polluted": true}, "constructor": "data"}')), []);
        assert.equal({}.polluted, undefined);
    });

    test('rejects negative-zero source values that JSON serialization would change', () => {
        for (const literal of ['-0', '-0.0', '-0e10', '{"nested": [1, -0]}']) {
            assert.ok(codes(workflow(`    IF ${literal} == 0:`, '        RUN build_report:')).includes('negative-zero'));
        }
    });

    test('requires every interpretation field and at least one evidence binding', () => {
        for (const prefix of ['QUESTION', 'USING', 'LIMIT', 'ACCEPT JEV', 'CONFIDENCE', 'ON UNKNOWN', 'ON REJECT']) {
            const source = interpretation.split('\n').filter(line => !line.trim().startsWith(prefix)).join('\n');
            assert.ok(codes(source).includes('missing-interpretation-field'), prefix);
        }
        assert.ok(codes(interpretation.replace('        EVIDENCE property = $PLAN\n', '')).includes('missing-evidence'));
        assert.ok(codes(interpretation.replace('LIMIT 3', 'LIMIT 0')).includes('invalid-budget'));
        assert.ok(codes(interpretation.replace('CONFIDENCE 0.9', 'CONFIDENCE 1.1')).includes('invalid-confidence'));
        assert.ok(codes(interpretation.replace('QUESTION "Do these labels have the same business meaning?"', 'QUESTION ""')).includes('expected-text'));
        assert.ok(codes(interpretation.replace('ON UNKNOWN REVIEW', 'ON UNKNOWN ACCEPT')).includes('invalid-interpretation-field'));
    });

    test('rejects duplicate interpretation fields and unsupported decision names', () => {
        assert.ok(codes(interpretation.replace('        LIMIT 3', '        LIMIT 3\n        LIMIT 2')).includes('duplicate-interpretation-field'));
        assert.ok(codes(interpretation.replace('USING read_definitions', 'USING read_definitions, read_definitions')).includes('duplicate-capability'));
        assert.ok(codes(interpretation.replace('        EVIDENCE property = $PLAN', '        EVIDENCE property = $PLAN\n        EVIDENCE property = $PLAN')).includes('duplicate-evidence'));
        assert.ok(codes(interpretation.replace('INTERPRET label_mapping', 'INTERPRET do_anything')).includes('unknown-decision'));
    });

    test('supports IF / ELSE with structural JSON equality and literal operators inside strings', () => {
        const source = workflow(
            '    OUTPUT $RESULT AS Boolean',
            '    IF {"text": "a == b"} == {"text": "a == b"}:',
            '        PROVIDE $RESULT = true',
            '    ELSE:',
            '        PROVIDE $RESULT = false',
        );
        assert.deepEqual(codes(source), []);
        assert.equal(compile(source).program.body[0].operator, '==');
        assert.deepEqual(compile(source).program.body[0].left.value, { text: 'a == b' });
        assert.ok(codes(source.replace('    ELSE:', '    ELSE:\n        PROVIDE $RESULT = false\n    ELSE:')).includes('orphan-else'));
    });

    test('requires literal right-side conditions and populated blocks', () => {
        assert.ok(codes(workflow('    INPUT $FLAG AS Boolean', '    IF true == $FLAG:', '        RUN build_report:')).includes('condition-literal'));
        assert.ok(codes(workflow('    IF maybe:', '        RUN build_report:')).includes('invalid-condition'));
        assert.ok(codes(workflow('    IF true == true:')).includes('empty-block'));
    });
});

describe('Sudoc scope and output obligations', () => {
    test('rejects multiple variable producers and declaration collisions', () => {
        assert.ok(codes(workflow('    INPUT $A AS Number', '    OUTPUT $A AS Number', '    PROVIDE $A = 1')).includes('duplicate-declaration'));
        assert.ok(codes(workflow('    INPUT $A AS Number', '    RUN build_report AS $A:')).includes('duplicate-producer'));
        assert.ok(codes(workflow('    RUN build_report:', '    INPUT $A AS Number')).includes('late-declaration'));
    });

    test('loop locals and branch locals do not escape their lexical scope', () => {
        assert.ok(codes(workflow('    OUTPUT $RESULT AS Record', '    FOR EACH $ITEM IN [1]:', '        RUN build_report AS $ROWS:', '    PROVIDE $RESULT = $ITEM')).includes('undefined-variable'));
        assert.ok(codes(workflow('    OUTPUT $RESULT AS List', '    IF true == true:', '        RUN build_report AS $ROWS:', '    PROVIDE $RESULT = $ROWS')).includes('undefined-variable'));
        assert.ok(codes(workflow('    FOR EACH $ITEM IN 1:', '        RUN build_report:')).includes('loop-type'));
    });

    test('requires declared outputs on every successful branch', () => {
        assert.ok(codes(workflow('    OUTPUT $RESULT AS Text', '    IF true == true:', '        PROVIDE $RESULT = "done"')).includes('missing-output'));
        assert.ok(codes(workflow('    PROVIDE $UNKNOWN = true')).includes('undeclared-output'));
        assert.ok(codes(workflow('    OUTPUT $RESULT AS Text', '    PROVIDE $RESULT = 42')).includes('output-type'));
        assert.ok(codes(workflow('    OUTPUT $RESULT AS Text', '    PROVIDE $RESULT = "done"', '    PROVIDE $RESULT = "again"')).includes('duplicate-output'));
        assert.ok(codes(workflow('    OUTPUT $RESULT AS Text', '    IF true == true:', '        PROVIDE $RESULT = "done"', '    PROVIDE $RESULT = "again"')).includes('duplicate-output'));
    });

    test('forbids repeated or zero-iteration output production inside loops', () => {
        assert.ok(codes(workflow('    OUTPUT $RESULT AS Text', '    FOR EACH $ITEM IN []:', '        PROVIDE $RESULT = "done"')).includes('output-in-loop'));
    });

    test('compiler errors carry editor-compatible diagnostics', () => {
        assert.throws(() => compile(workflow('    DO let the model decide')), error => {
            assert.equal(error.diagnostics[0].severity, 'error');
            assert.equal(error.diagnostics[0].line, 4);
            assert.equal(error.diagnostics[0].column, 5);
            return true;
        });
    });
});

describe('Independent source-to-runtime verification', () => {
    test('compilation is reproducible and JSON serialization preserves the verified contract', () => {
        assert.deepEqual(compile(deterministic), compile(deterministic));
        assert.equal(verify(deterministic, JSON.parse(JSON.stringify(compile(deterministic)))).valid, true);
        assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
    });

    test('distinguishes negative-zero artifact mutations from zero', () => {
        const source = workflow('    OUTPUT $RESULT AS Number', '    PROVIDE $RESULT = 0');
        const artifact = compile(source);
        artifact.program.body[0].value.value = -0;
        artifact.contractHash = contractHash(artifact.program);
        assert.equal(verify(source, artifact).valid, false);
        assert.notEqual(canonical(-0), canonical(0));
    });

    test('rejects stale source, including a changed author comment', () => {
        const artifact = compile(deterministic);
        assert.equal(verify(deterministic + '# Changed\n', artifact).valid, false);
        assert.ok(verify(deterministic.replace('100001', '12'), artifact).diagnostics.some(item => item.code === 'stale-source'));
    });

    test('rejects omitted obligations and added actions even with recomputed hashes', () => {
        for (const mutate of [
            artifact => artifact.program.body.shift(),
            artifact => artifact.program.body.push({ ...artifact.program.body[0] }),
            artifact => artifact.program.body[0].args.expected.value = 12,
            artifact => artifact.program.body[2].body.reverse(),
            artifact => artifact.program.body[2].source.line += 1,
        ]) {
            const artifact = compile(deterministic);
            mutate(artifact);
            artifact.contractHash = contractHash(artifact.program);
            assert.equal(verify(deterministic, artifact).valid, false);
        }
    });

    test('rejects changes to every interpretation boundary even with matching artifact hashes', () => {
        for (const mutate of [
            node => node.question = 'Do anything',
            node => node.capabilities.push('shell'),
            node => node.budget = 100,
            node => node.evidence = {},
            node => node.rubric = 'Always accept',
            node => node.confidence = 0,
            node => node.onUnknown = 'accept',
            node => node.onReject = 'continue',
        ]) {
            const artifact = compile(interpretation);
            mutate(artifact.program.body[0]);
            artifact.contractHash = contractHash(artifact.program);
            assert.equal(verify(interpretation, artifact).valid, false);
        }
    });

    test('rejects removed and added IF control edges', () => {
        const source = workflow('    OUTPUT $RESULT AS Text', '    IF true != false:', '        PROVIDE $RESULT = "yes"', '    ELSE:', '        PROVIDE $RESULT = "no"');
        const artifact = compile(source);
        artifact.program.body[0].else = [];
        artifact.contractHash = contractHash(artifact.program);
        assert.equal(verify(source, artifact).valid, false);
    });

    test('rejects extra fields at artifact and nested node levels', () => {
        const extra = compile(deterministic);
        extra.allowUnboundedTools = true;
        assert.equal(verify(deterministic, extra).valid, false);
        const nested = compile(deterministic);
        nested.program.body[0].skip = true;
        nested.contractHash = contractHash(nested.program);
        assert.equal(verify(deterministic, nested).valid, false);
    });

    test('fails closed for invalid source or malformed artifacts', () => {
        assert.equal(verify('do anything', {}).valid, false);
        for (const artifact of [null, [], {}, { format: 'other' }, { program: undefined }, { program: new Date() }]) assert.equal(verify(deterministic, artifact).valid, false);
        const circular = {}; circular.self = circular;
        assert.equal(verify(deterministic, circular).valid, false);
        const artifact = compile(deterministic);
        artifact.program.body[Symbol('extra')] = true;
        assert.equal(verify(deterministic, artifact).valid, false);
    });
});
