const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('./language');
const { complete, definition, hover, template, templateNames } = require('./language-services');

function atReplacement(find, replacement, source = template('sms')) {
    const lines = source.split('\n');
    const index = lines.findIndex(line => line.includes(find));
    assert.notEqual(index, -1, `Missing fixture text ${find}`);
    lines[index] = lines[index].slice(0, lines[index].indexOf(find)) + replacement;
    return { source: lines.join('\n'), line: index + 1, column: lines[index].length + 1 };
}
function choices(input, options) { return complete(input.source, input.line, input.column, options); }

test('templates are editable source and distinguish a complete example from a draft with holes', () => {
    assert.deepEqual(templateNames(), ['workflow', 'sms', 'send_sms']);
    assert.equal(analyze(template('sms'), { strict: true }).ready, true);
    const draft = analyze(template('workflow'), { strict: true });
    assert.equal(draft.ready, false);
    assert.ok(draft.diagnostics.some(item => item.code === 'unfinished-contract' && item.severity === 'error'));
    assert.match(template('send_sms'), /WITH to = \?/);
    assert.match(template('send_sms'), /ON unknown:/);
    assert.throws(() => template('../../package.json'), /Unknown template/);
});

test('argument completion suggests compatible record projections and excludes unproduced results', () => {
    const input = atReplacement('WITH to = $CUSTOMER.phone', 'WITH to = $');
    const result = choices(input);
    assert.ok(result.some(item => item.label === '$CUSTOMER.phone'));
    assert.ok(!result.some(item => item.label === '$MESSAGE' || item.label === '$RECEIPT'));
    const item = result.find(item => item.label === '$CUSTOMER.phone');
    assert.equal(item.range.endColumn, input.column);
    assert.equal(item.range.column, input.column - 1);
    assert.equal(item.insertText, '$CUSTOMER.phone');
});

test('field completion uses known type and expected argument type', () => {
    const result = choices(atReplacement('WITH body = $MESSAGE', 'WITH body = $CUSTOMER.'));
    assert.deepEqual(result.map(item => item.label).sort(), ['name', 'phone']);
    assert.ok(result.every(item => item.range.column === item.range.endColumn));
    assert.deepEqual(choices(atReplacement('WITH body = $MESSAGE', 'WITH body = $UNDECLARED.')), []);
});

test('conditions and output targets have specific completion candidates', () => {
    assert.deepEqual(choices(atReplacement('DECIDE $CAN_SEND:', 'DECIDE $')).map(item => item.label), ['$CAN_SEND']);
    assert.deepEqual(choices(atReplacement('PRODUCES $RECEIPT', 'PRODUCES $')).map(item => item.label), ['$RECEIPT']);
});

test('action arguments and branch completions exclude already supplied alternatives', () => {
    const args = choices(atReplacement('WITH to = $CUSTOMER.phone', 'WITH '));
    assert.deepEqual(args.map(item => item.label), ['to']);
    assert.equal(args[0].insertText, 'to = ');
    const outcomes = choices(atReplacement('ON failure:', 'ON '));
    assert.deepEqual(outcomes.map(item => item.label), ['failure']);
});

test('statement snippets respect parent structure even in unfinished documents', () => {
    const result = choices(atReplacement('WITH to = $CUSTOMER.phone', ''));
    assert.ok(result.some(item => item.label === 'WITH'));
    assert.ok(!result.some(item => ['INPUT', 'EXIT', 'WHEN'].includes(item.label)));
    const decisions = choices(atReplacement('WHEN true:', ''));
    assert.deepEqual(decisions.map(item => item.label), ['WHEN']);
});

test('definition and hover resolve references to precise declarations', () => {
    const source = template('sms');
    const lines = source.split('\n');
    const line = lines.findIndex(text => text.includes('WITH body')) + 1;
    const column = lines[line - 1].indexOf('$MESSAGE') + 2;
    const location = definition(source, line, column);
    assert.equal(lines[location.line - 1].slice(location.column - 1, location.endColumn - 1), '$MESSAGE');
    assert.match(hover(source, line, column).contents, /\$MESSAGE: Text/);
    assert.equal(definition(source, 1, 1), null);
});

test('failure branches cannot complete action results available only on success', () => {
    const source = template('sms').replace('PRODUCES $RECEIPT', 'PRODUCES $LOCAL_RECEIPT');
    const failed = choices(atReplacement('NOTE The provider rejected', 'NOTE $', source));
    assert.ok(!failed.some(item => item.label === '$LOCAL_RECEIPT' || item.label === '$RECEIPT'));
    const succeeded = choices(atReplacement('NOTE Retain', 'NOTE $', source));
    assert.ok(succeeded.some(item => item.label === '$LOCAL_RECEIPT'));
});

test('legacy completion preserves lexical loop scope', () => {
    const source = '@WORKFLOW:\n    DEFINE $SOURCE AS rows\n    FOR EACH $ROW IN $SOURCE:\n        DO $ROW\n    NOTE $\n';
    const results = complete(source, 5, '    NOTE $'.length + 1);
    assert.deepEqual(results.map(item => item.label), ['$SOURCE']);
});

test('comments have no completions and prose dollar variables remain literal in templates', () => {
    assert.deepEqual(complete('@WORKFLOW:\n    # $', 2, 8), []);
    const source = '@WORKFLOW:\n    ';
    const item = complete(source, 2, 5).find(result => result.label === 'DEFINE');
    assert.ok(item);
    assert.equal(item.insertText, 'DEFINE $NAME AS description');
    assert.ok(!item.snippet);
});

test('custom catalog field shapes feed the same completion service', () => {
    const catalog = { types: { Account: { fields: { contact: 'Customer', code: 'Text' } } } };
    const input = atReplacement('WITH body = $MESSAGE', 'WITH body = $CUSTOMER.contact.',
        template('sms').replace('AS Customer', 'AS Account'));
    assert.deepEqual(choices(input, { catalog }).map(item => item.label).sort(), ['name', 'phone']);
});

test('unknown inherited action names remain safe to edit and inspect', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
        const source = `@WORKFLOW:\n    CONTRACT 1\n    DO ${name}:\n        WITH `;
        assert.deepEqual(complete(source, 4, 14), []);
        assert.equal(hover(source, 3, 10), null);
    }
});

test('completion before indentation produces a valid insertion range', () => {
    const result = complete('    ', 1, 1);
    assert.ok(result.length);
    assert.ok(result.every(item => item.range.column === 1 && item.range.endColumn === 1));
});

test('outcome completion respects case-insensitive syntax and exclusive navigation ranges', () => {
    const outcomes = choices(atReplacement('ON unknown:', 'ON UN'));
    assert.deepEqual(outcomes.map(item => item.label), ['unknown']);
    const source = '@WORKFLOW:\n    DEFINE $SOURCE AS rows\n    NOTE $SOURCE end\n';
    const columnAfterName = '    NOTE $SOURCE'.length + 1;
    assert.equal(definition(source, 3, columnAfterName), null);
});

test('formal strings, source bindings, and comments do not resolve literal dollar names', () => {
    for (const statement of ['CONDITION $LITERAL AS $MESSAGE == "$CUSTOMER"', 'INPUT $LITERAL AS Text FROM "$CUSTOMER"', '# $CUSTOMER']) {
        const input = atReplacement('CONDITION $CAN_SEND AS $CUSTOMER.smsEnabled == true', statement);
        const text = input.source.split('\n')[input.line - 1];
        const column = text.lastIndexOf('$CUSTOMER') + 4;
        assert.deepEqual(complete(input.source, input.line, column), []);
        assert.equal(definition(input.source, input.line, column), null);
        assert.equal(hover(input.source, input.line, column), null);
    }
});

test('action hover applies only to the action name under the cursor', () => {
    const source = template('sms');
    const lines = source.split('\n');
    const line = lines.findIndex(text => text.includes('DO send_sms')) + 1;
    assert.equal(hover(source, line, 1), null);
    assert.equal(hover(source, line, lines[line - 1].length + 1), null);
    assert.match(hover(source, line, lines[line - 1].indexOf('send_sms') + 2).contents, /send_sms\(to: PhoneNumber/);
});
