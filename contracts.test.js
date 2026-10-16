const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { analyze, format } = require('./language');
const { resolveCatalog } = require('./catalog');

const sms = fs.readFileSync(path.join(__dirname, 'examples/sms-contract.workflow'), 'utf8');
const strict = source => analyze(source, { strict: true });
const codes = source => strict(source).diagnostics.filter(d => d.severity === 'error').map(d => d.code);
const simple = (...body) => [
    '@WORKFLOW:', '    CONTRACT 1', '    INPUT $VALUE AS Text FROM "request.value"',
    '    INPUT $ENABLED AS Boolean FROM "request.enabled"', '    OUTPUT $RESULT AS Text',
    '    CONDITION $READY AS $ENABLED == true', ...body,
].join('\n') + '\n';
const decision = (trueLines, falseLines = ['EXIT FAILURE'], unknownLines = ['EXIT REVIEW']) => [
    '    DECIDE $READY:', '        WHEN true:', ...trueLines.map(line => '            ' + line),
    '        WHEN false:', ...falseLines.map(line => '            ' + line),
    '        WHEN unknown:', ...unknownLines.map(line => '            ' + line),
];

describe('Explicit opt-in and readiness', () => {
    test('keeps legacy authoring compatible but refuses strict readiness', () => {
        const legacy = '@WORKFLOW:\n    DO inspect the screen\n';
        assert.equal(analyze(legacy).mode, 'legacy');
        assert.deepEqual(analyze(legacy).diagnostics, []);
        assert.equal(strict(legacy).ready, false);
        assert.ok(codes(legacy).includes('contract-required'));
    });
    test('requires version, inputs, output and conditions', () => {
        assert.ok(codes('@WORKFLOW:\n    CONTRACT 2\n    EXIT FAILURE\n').includes('invalid-contract-syntax'));
        const result = codes('@WORKFLOW:\n    CONTRACT 1\n    EXIT FAILURE\n');
        for (const code of ['input-required', 'output-required', 'condition-required']) assert.ok(result.includes(code));
        assert.ok(codes(simple('    CONTRACT 1', '    EXIT FAILURE')).includes('contract-required'));
    });
    test('the complete SMS sample is ready and formatting is idempotent', () => {
        const result = strict(sms);
        assert.equal(result.ready, true);
        assert.deepEqual(result.diagnostics, []);
        assert.equal(format(format(sms)), format(sms));
    });
    test('keeps holes editable while strict readiness rejects them', () => {
        const draft = sms.replace('FROM "request.customer"', 'FROM ?').replace('WITH body = $MESSAGE', 'WITH body = ?');
        const result = analyze(draft);
        assert.equal(result.ready, false);
        assert.equal(result.diagnostics.filter(d => d.code === 'unfinished-contract').length, 2);
        assert.ok(result.diagnostics.filter(d => d.code === 'unfinished-contract').every(d => d.severity === 'warning'));
        assert.ok(strict(draft).diagnostics.filter(d => d.code === 'unfinished-contract').every(d => d.severity === 'error'));
        assert.doesNotThrow(() => format(draft));
    });
    test('requires explicit nonempty source bindings', () => {
        assert.ok(codes(sms.replace('FROM "request.customer"', 'FROM ""')).includes('invalid-source'));
        assert.ok(codes(sms.replace('FROM "request.customer"', 'FROM customer')).includes('invalid-source'));
        assert.ok(codes(sms.replace(' FROM "request.customer"', '')).includes('invalid-contract-syntax'));
    });
});

describe('Formal conditions and typed dependencies', () => {
    test('checks fields, scoped references and nominal types', () => {
        assert.ok(codes(sms.replace('$CUSTOMER.phone', '$CUSTOMER.missing')).includes('unknown-field'));
        assert.ok(codes(sms.replace('WITH to = $CUSTOMER.phone', 'WITH to = $MESSAGE')).includes('type-mismatch'));
        assert.ok(codes(sms.replace('WITH body = $MESSAGE', 'WITH body = $LATER')).includes('undefined-variable'));
        assert.ok(codes(sms.replace('AS Customer', 'AS MissingType')).includes('unknown-type'));
    });
    test('handles precedence and parentheses without evaluating arbitrary code', () => {
        const valid = sms.replace('$CUSTOMER.smsEnabled == true', 'NOT ($CUSTOMER.smsEnabled == false) AND (2 >= 1 OR unknown)');
        assert.deepEqual(codes(valid), []);
        for (const expression of ['$CUSTOMER.phone', '$CUSTOMER.smsEnabled AND "yes"', '$CUSTOMER.phone > 3', '$CUSTOMER.smsEnabled === true', 'process.exit()', '($CUSTOMER.smsEnabled == true']) {
            assert.equal(strict(sms.replace('$CUSTOMER.smsEnabled == true', expression)).ready, false, expression);
        }
    });
    test('treats unknown as a decision outcome, not a known typed action argument', () => {
        assert.deepEqual(codes(sms.replace('$CUSTOMER.smsEnabled == true', 'unknown')), []);
        assert.ok(codes(sms.replace('WITH body = $MESSAGE', 'WITH body = unknown')).includes('type-mismatch'));
    });
    test('conditions and sources cannot read unproduced output values', () => {
        assert.ok(codes(sms.replace('$CUSTOMER.smsEnabled == true', '$RECEIPT.status == "sent"')).includes('unavailable-output'));
        assert.ok(codes(simple('    PROVIDE $RESULT = $RESULT', '    EXIT SUCCESS')).includes('unavailable-output'));
    });
    test('requires named conditions and rejects duplicate or malformed names', () => {
        assert.ok(codes(sms.replace('DECIDE $CAN_SEND:', 'DECIDE $CUSTOMER:')).includes('condition-required'));
        assert.ok(codes(sms.replace('INPUT $MESSAGE', 'INPUT $CUSTOMER')).includes('duplicate-variable'));
        assert.ok(codes(sms.replaceAll('$MESSAGE', '$message')).includes('invalid-variable-name'));
    });
});

describe('Path-dependent production and exits', () => {
    test('checks all successful exits and never promises output on failure or review', () => {
        const incomplete = simple(...decision(['PROVIDE $RESULT = $VALUE', 'EXIT SUCCESS'], ['EXIT SUCCESS']));
        const missing = strict(incomplete).diagnostics.filter(d => d.code === 'missing-output');
        assert.equal(missing.length, 1);
        assert.equal(missing[0].line, 12);
        assert.deepEqual(codes(simple(...decision(['PROVIDE $RESULT = $VALUE', 'EXIT SUCCESS']))), []);
    });
    test('joins production only across continuing paths', () => {
        const joined = simple(...decision(['PROVIDE $RESULT = $VALUE']), '    NOTE Continue with $RESULT', '    EXIT SUCCESS');
        assert.deepEqual(codes(joined), []);
        const partial = simple(...decision(['PROVIDE $RESULT = $VALUE'], ['NOTE Continue without a value']), '    EXIT SUCCESS');
        assert.ok(codes(partial).includes('missing-output'));
    });
    test('requires all decision and action outcomes and explicit terminal exits', () => {
        const noUnknown = sms.replace('        WHEN unknown:\n            NOTE Obtain reliable consent evidence before proceeding.\n            EXIT REVIEW\n', '');
        assert.ok(codes(noUnknown).includes('missing-outcome'));
        assert.ok(codes(sms.replace('ON unknown:', 'ON pending:')).includes('missing-outcome'));
        assert.ok(codes(sms.replace('ON unknown:', 'ON failure:')).includes('duplicate-outcome'));
        assert.ok(codes(simple('    PROVIDE $RESULT = $VALUE')).includes('missing-exit'));
    });
    test('only the action success branch receives its produced result', () => {
        const bad = sms.replace('NOTE The provider rejected the request; no successful receipt is promised.', 'NOTE Inspect $RECEIPT.id');
        assert.ok(codes(bad).includes('unavailable-output'));
        const badSuccess = sms.replace('ON failure:\n                    NOTE The provider rejected the request; no successful receipt is promised.\n                    EXIT FAILURE', 'ON failure:\n                    EXIT SUCCESS');
        assert.ok(codes(badSuccess).includes('missing-output'));
    });
    test('keeps branch-local inputs from escaping', () => {
        const source = simple(...decision(['INPUT $LOCAL AS Text FROM "local"', 'PROVIDE $RESULT = $LOCAL']), '    NOTE $LOCAL', '    EXIT SUCCESS');
        assert.ok(codes(source).includes('undefined-variable'));
    });
    test('can project a local typed action result into a workflow output', () => {
        const source = sms.replace('OUTPUT $RECEIPT AS SmsReceipt', 'OUTPUT $ID AS Text')
            .replace('PRODUCES $RECEIPT', 'PRODUCES $SENT')
            .replace('NOTE Retain $RECEIPT.id as evidence of provider acceptance.', 'PROVIDE $ID = $SENT.id');
        assert.deepEqual(codes(source), []);
    });
    test('requires valid output assignment targets and types', () => {
        assert.ok(codes(simple('    PROVIDE $VALUE = "replace input"', '    EXIT FAILURE')).includes('output-required'));
        assert.ok(codes(simple('    PROVIDE $RESULT = 42', '    EXIT SUCCESS')).includes('type-mismatch'));
    });
});

describe('Typed action catalog', () => {
    test('requires arguments, result bindings and known action names', () => {
        assert.ok(codes(sms.replace('                WITH to = $CUSTOMER.phone\n', '')).includes('missing-argument'));
        assert.ok(codes(sms.replace('                PRODUCES $RECEIPT\n', '')).includes('missing-production'));
        assert.ok(codes(sms.replace('WITH to =', 'WITH recipient =')).includes('unknown-argument'));
        assert.ok(codes(sms.replace('DO send_sms:', 'DO send_email:')).includes('unknown-action'));
        assert.ok(codes(sms.replace('WITH body = $MESSAGE', 'WITH to = $CUSTOMER.phone')).includes('duplicate-argument'));
    });
    test('refuses binding action results over immutable inputs', () => {
        assert.ok(codes(sms.replace('PRODUCES $RECEIPT', 'PRODUCES $CUSTOMER')).includes('invalid-production'));
    });
    test('extends record and action catalogs without execution', () => {
        const catalog = {
            types: { Ticket: { fields: { body: 'Text' } } },
            actions: { prepare: { arguments: { source: { type: 'Ticket', required: true } }, output: 'Text', outcomes: ['success', 'failure', 'unknown'] } },
        };
        const source = simple('    INPUT $TICKET AS Ticket FROM "request.ticket"', '    DO prepare:', '        WITH source = $TICKET', '        PRODUCES $RESULT', '        ON success:', '            EXIT SUCCESS', '        ON failure:', '            EXIT FAILURE', '        ON unknown:', '            EXIT REVIEW');
        assert.equal(analyze(source, { strict: true, catalog }).ready, true);
    });
    test('rejects malformed catalog overrides rather than weakening checks', () => {
        for (const bad of [null, [], { types: [] }, { types: { Wrong: { fields: { value: 'Missing' } } } }, { types: { Loop: { base: 'Loop' } } }, { actions: { send_sms: {} } }, { actions: { send_sms: { arguments: { to: { type: 'Text', required: 'yes' } }, output: 'Text', outcomes: ['success'] } } }]) {
            assert.throws(() => resolveCatalog(bad), /Invalid domain catalog/);
        }
    });
});

describe('Shared authoring metadata', () => {
    test('exposes precise reference ranges, declaration links and path availability', () => {
        const result = strict(sms);
        const reference = result.references.find(ref => ref.name === '$CUSTOMER' && ref.line === 13);
        assert.deepEqual(reference.declaration, { line: 4, column: 11, endLine: 4, endColumn: 20 });
        assert.equal(reference.column, 27);
        assert.ok(!result.availableSymbolsByLine[13].some(symbol => symbol.name === '$RECEIPT'));
        assert.ok(result.availableSymbolsByLine[17].some(symbol => symbol.name === '$RECEIPT'));
        const missingField = strict(sms.replace('$CUSTOMER.phone', '$CUSTOMER.missing')).diagnostics.find(d => d.code === 'unknown-field');
        assert.deepEqual([missingField.line, missingField.column, missingField.endColumn], [13, 37, 44]);
    });
    test('all deterministic diagnostics have one-based end ranges and a category', () => {
        const result = strict(sms.replace('WITH to = $CUSTOMER.phone', 'WITH to = $MISSING.missing'));
        for (const diagnostic of result.diagnostics) {
            assert.ok(diagnostic.line >= 1 && diagnostic.column >= 1);
            assert.ok(diagnostic.endLine >= diagnostic.line && diagnostic.endColumn > diagnostic.column);
            assert.ok(['syntax', 'contract'].includes(diagnostic.category));
        }
    });
    test('preserves legacy navigation metadata', () => {
        const result = analyze('@WORKFLOW:\n    DEFINE $VALUE AS source\n    DO inspect $VALUE\n');
        assert.equal(result.symbols[0].name, '$VALUE');
        assert.equal(result.references[0].declaration.line, 2);
    });
});


test('blank-line completion retains success values and updates after branch joins', () => {
    const branch = sms.replace('                    EXIT SUCCESS', '                    \n                    EXIT SUCCESS');
    const result = strict(branch);
    assert.ok(result.availableSymbolsByLine[18].some(symbol => symbol.name === '$RECEIPT'));
    const joined = simple(...decision(['PROVIDE $RESULT = $VALUE']), '    ', '    EXIT SUCCESS');
    const blankLine = joined.split('\n').findIndex(line => line === '    ') + 1;
    assert.ok(strict(joined).availableSymbolsByLine[blankLine].some(symbol => symbol.name === '$RESULT'));
    const partial = simple(...decision(['PROVIDE $RESULT = $VALUE'], ['NOTE no result']), '    ', '    EXIT FAILURE');
    const partialBlank = partial.split('\n').findIndex(line => line === '    ') + 1;
    assert.ok(!strict(partial).availableSymbolsByLine[partialBlank].some(symbol => symbol.name === '$RESULT'));
});

test('lexical scope includes trailing blanks until a real dedent', () => {
    const legacy = analyze('@WORKFLOW:\n    DEFINE $VALUE AS source\n    \n');
    assert.equal(legacy.symbols[0].scope.endLine, 4);
    const draft = simple('    NOTE continue', '    ');
    const result = strict(draft);
    const input = result.symbols.find(symbol => symbol.name === '$VALUE');
    assert.equal(input.scope.endLine, draft.split('\n').length);
    assert.ok(result.availableSymbolsByLine[8].some(symbol => symbol.name === '$VALUE'));
});

test('v1 preserves global workflow identity and record fields reject inherited object keys', () => {
    assert.ok(codes(sms.replace('Send the requested location code to the consenting customer.', 'Notify @OTHER.')).includes('undefined-workflow'));
    assert.ok(!codes(sms.replace('Send the requested location code to the consenting customer.', 'Notify joseph@example.com on @WORKFLOW.')).includes('undefined-workflow'));
    assert.ok(codes(sms.replace('$CUSTOMER.phone', '$CUSTOMER.constructor')).includes('unknown-field'));
});


test('unreachable condition declarations do not satisfy required contracts', () => {
    const source = '@WORKFLOW:\n    CONTRACT 1\n    INPUT $VALUE AS Text FROM "request.value"\n    OUTPUT $RESULT AS Text\n    PROVIDE $RESULT = $VALUE\n    EXIT SUCCESS\n    CONDITION $LATE AS true\n';
    const result = strict(source);
    assert.equal(result.ready, false);
    assert.ok(result.diagnostics.some(item => item.code === 'condition-required'));
    assert.equal(result.conditions[0].reachable, false);
});

test('file-wide output contracts apply even when declared after an exit', () => {
    const valid = '@WORKFLOW:\n    CONTRACT 1\n    INPUT $VALUE AS Text FROM "request.value"\n    CONDITION $READY AS true\n    PROVIDE $RESULT = $VALUE\n    EXIT SUCCESS\n    OUTPUT $RESULT AS Text\n';
    assert.equal(strict(valid).ready, true);
    assert.ok(codes(valid.replace('    PROVIDE $RESULT = $VALUE\n', '')).includes('missing-output'));
});


test('catalog cannot redefine internal analysis sentinels or intrinsic literal semantics', () => {
    for (const catalog of [
        { types: { Invalid: {} } }, { types: { Unknown: {} } },
        { types: { Text: { base: 'Number' } } }, { types: { Number: { fields: { number: 'Text' } } } },
        { types: { Boolean: { base: 'Text' } } }, { types: { Decision: { fields: {} } } },
    ]) assert.throws(() => resolveCatalog(catalog), /reserved analysis type|intrinsic scalar type/);
    assert.doesNotThrow(() => resolveCatalog({ types: { Text: { description: 'Custom help for text.' } } }));
});

test('unknown operands do not conceal invalid known comparison types', () => {
    for (const expression of ['"not a number" > unknown', 'unknown <= true', '$CUSTOMER > unknown']) {
        assert.ok(codes(sms.replace('$CUSTOMER.smsEnabled == true', expression)).includes('expression-type'), expression);
    }
    assert.deepEqual(codes(sms.replace('$CUSTOMER.smsEnabled == true', 'unknown < 1')), []);
});

test('expression references use RHS positions even for self references and lowercase as', () => {
    for (const statement of ['CONDITION $READY AS $READY', 'condition $READY as $READY']) {
        const source = '@WORKFLOW:\n    CONTRACT 1\n    INPUT $VALUE AS Text FROM "source"\n    OUTPUT $RESULT AS Text\n    ' + statement + '\n    EXIT FAILURE\n';
        const result = strict(source);
        const diagnostic = result.diagnostics.find(item => item.code === 'undefined-variable');
        const raw = source.split('\n')[4];
        assert.equal(diagnostic.column, raw.lastIndexOf('$READY') + 1);
        assert.equal(result.references.find(item => item.name === '$READY').column, diagnostic.column);
    }
    const source = simple('    PROVIDE $RESULT = $RESULT', '    EXIT SUCCESS');
    const result = strict(source);
    const diagnostic = result.diagnostics.find(item => item.code === 'unavailable-output');
    assert.equal(diagnostic.column, source.split('\n')[6].lastIndexOf('$RESULT') + 1);
    assert.ok(result.references.some(item => item.name === '$RESULT' && !item.write && item.column === diagnostic.column));
});


test('scalar subtypes use their base semantics in formal conditions', () => {
    const catalog = { types: { Flag: { base: 'Boolean' }, Money: { base: 'Number' }, Choice: { base: 'Decision' } } };
    for (const [type, expression] of [['Flag', '$VALUE'], ['Flag', '$VALUE AND NOT false'], ['Money', '$VALUE > 3'], ['Choice', '$VALUE OR unknown']]) {
        const source = '@WORKFLOW:\n    CONTRACT 1\n    INPUT $VALUE AS ' + type + ' FROM "source"\n    OUTPUT $RESULT AS Text\n    CONDITION $READY AS ' + expression + '\n    PROVIDE $RESULT = "checked"\n    EXIT SUCCESS\n';
        const result = analyze(source, { strict: true, catalog });
        assert.equal(result.ready, true, JSON.stringify(result.diagnostics));
    }
});

test('unreachable success statements do not create fictitious output paths', () => {
    const source = simple(...decision(['PROVIDE $RESULT = $VALUE', 'EXIT SUCCESS']), '    EXIT SUCCESS');
    const result = strict(source);
    assert.equal(result.ready, true);
    assert.ok(result.diagnostics.some(item => item.code === 'unreachable'));
    assert.ok(!result.diagnostics.some(item => item.code === 'missing-output'));
});
