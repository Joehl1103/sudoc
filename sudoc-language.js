'use strict';

const catalog = require('./sudoc-catalog');

const NAME = '\\$[A-Z][A-Z0-9_]*';
const TYPES = ['Number', 'Text', 'Boolean', 'List', 'Record'];
const IDENTIFIER = '[a-z][a-z0-9_]*';
const declarationPattern = new RegExp(`^(INPUT|OUTPUT) (${NAME}) AS (${TYPES.join('|')})$`);
const expressionReference = new RegExp(`^(${NAME})((?:\\.[A-Za-z_][A-Za-z0-9_]*)*)$`);

function issue(diagnostics, line, code, message) {
    diagnostics.push({ line: line.number || line.line || 1, column: line.indent === undefined ? (line.column || 1) : line.indent + 1, code, message, severity: 'error' });
}

function location(line) {
    return { line: line.number, column: line.indent + 1 };
}

// JSON.parse silently keeps the last duplicate object member. Reject such source
// ambiguity, including escaped spellings of the same key, before lowering it.
// This scanner runs only after JSON.parse has validated the complete grammar.
function duplicateJsonKey(text) {
    const tokens = text.match(/"(?:\\.|[^"\\])*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,]/g);
    let position = 0;
    let duplicate;
    function value() {
        const token = tokens[position++];
        if (token === '{') {
            const keys = new Set();
            while (tokens[position] !== '}') {
                const key = JSON.parse(tokens[position++]);
                if (keys.has(key) && duplicate === undefined) duplicate = key;
                keys.add(key);
                position += 1; // colon
                value();
                if (tokens[position] === ',') position += 1;
            }
            position += 1;
        } else if (token === '[') {
            while (tokens[position] !== ']') {
                value();
                if (tokens[position] === ',') position += 1;
            }
            position += 1;
        }
    }
    value();
    return duplicate;
}

function expression(text, line, diagnostics) {
    const reference = expressionReference.exec(text);
    if (reference) {
        const path = reference[2] ? reference[2].slice(1).split('.') : [];
        if (path.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) {
            issue(diagnostics, line, 'reserved-field', 'Prototype-related fields are not available to workflow expressions.');
        }
        return { kind: 'ref', name: reference[1], path };
    }
    try {
        const value = JSON.parse(text);
        const duplicate = duplicateJsonKey(text);
        if (duplicate !== undefined) issue(diagnostics, line, 'duplicate-json-key', `JSON object key ${JSON.stringify(duplicate)} is repeated; declare its value exactly once.`);
        // JSON.parse accepts overflowing numbers; executable values must be finite.
        const finite = item => typeof item === 'number' ? Number.isFinite(item) : item && typeof item === 'object' ? Object.values(item).every(finite) : true;
        if (!finite(value)) throw new Error('Non-finite value');
        const negativeZero = item => typeof item === 'number' ? Object.is(item, -0) : item && typeof item === 'object' ? Object.values(item).some(negativeZero) : false;
        if (negativeZero(value)) issue(diagnostics, line, 'negative-zero', 'Use 0 instead of -0; negative zero cannot survive JSON artifact serialization.');
        return { kind: 'literal', value };
    } catch {
        issue(diagnostics, line, 'invalid-expression', 'Use a JSON literal or a $UPPERCASE variable with optional .field references. Prose requires an explicit INTERPRET block.');
        return { kind: 'literal', value: null };
    }
}

function quoted(text, line, diagnostics) {
    const parsed = expression(text, line, diagnostics);
    if (parsed.kind !== 'literal' || typeof parsed.value !== 'string' || !parsed.value.trim()) {
        issue(diagnostics, line, 'expected-text', 'Use a nonempty JSON-quoted string.');
        return '';
    }
    return parsed.value;
}

function tree(source, diagnostics) {
    const lines = source.replace(/\r\n?/g, '\n').split('\n').map((raw, index) => ({ raw, number: index + 1, indent: raw.match(/^ */)[0].length, text: raw.trim(), children: [], depth: 0 }));
    const roots = [];
    const stack = [];
    let width;
    for (const line of lines) {
        if (/\t/.test(line.raw)) issue(diagnostics, line, 'tabs', 'Use spaces; tabs are not allowed in executable sudoc.');
        if (!line.text || line.text.startsWith('#')) continue;
        while (stack.length && stack.at(-1).indent >= line.indent) stack.pop();
        const parent = stack.at(-1);
        if (!parent) {
            if (line.indent) issue(diagnostics, line, 'root-indent', 'The workflow header must start at column 1.');
            roots.push(line);
        } else {
            if (width === undefined) width = line.indent - parent.indent;
            if (line.indent !== parent.indent + width) issue(diagnostics, line, 'inconsistent-indent', `Use a consistent indentation step of ${width} spaces.`);
            line.depth = parent.depth + 1;
            parent.children.push(line);
            if (!parent.text.endsWith(':')) issue(diagnostics, line, 'unexpected-indent', 'Only statements ending in a colon may contain a block.');
        }
        stack.push(line);
    }
    // Preserve comments at their authored level when normalizing indentation.
    for (const line of lines) {
        if (line.text.startsWith('#')) line.depth = width ? Math.round(line.indent / width) : 0;
    }
    return { roots, lines };
}

function requireBlock(line, diagnostics, allowEmpty = false) {
    if (!line.children.length && !allowEmpty) issue(diagnostics, line, 'empty-block', 'This statement requires an indented body.');
}

function requireLeaf(line, diagnostics) {
    if (line.children.length) issue(diagnostics, line, 'unexpected-block', 'This statement cannot contain an indented body.');
}

function bindings(line, prefix, diagnostics) {
    const result = {};
    for (const child of line.children) {
        requireLeaf(child, diagnostics);
        const match = child.text.match(new RegExp(`^${prefix} (${IDENTIFIER}) = (.+)$`));
        if (!match) {
            issue(diagnostics, child, 'invalid-binding', `Write ${prefix} argument = JSON-literal-or-reference.`);
            continue;
        }
        if (Object.hasOwn(result, match[1])) issue(diagnostics, child, 'duplicate-argument', `${match[1]} is specified more than once.`);
        result[match[1]] = expression(match[2], child, diagnostics);
    }
    return result;
}

function splitCondition(text) {
    let quotedString = false;
    let escaped = false;
    let nesting = 0;
    for (let index = 0; index < text.length - 1; index += 1) {
        const character = text[index];
        if (quotedString) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') quotedString = false;
        } else if (character === '"') quotedString = true;
        else if ('[{'.includes(character)) nesting += 1;
        else if (']}'.includes(character)) nesting -= 1;
        else if (nesting === 0 && ['==', '!='].includes(text.slice(index, index + 2))) {
            return [text.slice(0, index).trim(), text.slice(index, index + 2), text.slice(index + 2).trim()];
        }
    }
    return null;
}

function interpretation(line, match, diagnostics) {
    requireBlock(line, diagnostics);
    const node = { kind: 'interpret', decision: match[1], out: match[2], question: '', capabilities: [], budget: 0, evidence: {}, rubric: '', confidence: 0, onUnknown: 'review', onReject: 'failure', source: location(line) };
    const seen = new Set();
    for (const child of line.children) {
        requireLeaf(child, diagnostics);
        let field;
        let value;
        if ((value = child.text.match(/^QUESTION (.+)$/))) { field = 'question'; node.question = quoted(value[1], child, diagnostics); }
        else if ((value = child.text.match(/^USING (.+)$/))) {
            field = 'capabilities';
            node.capabilities = value[1].split(',').map(item => item.trim());
            if (node.capabilities.some(item => !new RegExp(`^${IDENTIFIER}$`).test(item))) issue(diagnostics, child, 'invalid-capability', 'USING requires comma-separated capability names.');
            if (new Set(node.capabilities).size !== node.capabilities.length) issue(diagnostics, child, 'duplicate-capability', 'List each capability only once.');
        } else if ((value = child.text.match(/^LIMIT (\d+)$/))) {
            field = 'budget'; node.budget = Number(value[1]);
            if (!Number.isSafeInteger(node.budget) || node.budget < 1) issue(diagnostics, child, 'invalid-budget', 'LIMIT must be a positive safe integer.');
        } else if ((value = child.text.match(new RegExp(`^EVIDENCE (${IDENTIFIER}) = (.+)$`)))) {
            if (Object.hasOwn(node.evidence, value[1])) issue(diagnostics, child, 'duplicate-evidence', `Evidence ${value[1]} is specified more than once.`);
            node.evidence[value[1]] = expression(value[2], child, diagnostics);
            continue;
        } else if ((value = child.text.match(/^ACCEPT JEV (.+)$/))) { field = 'rubric'; node.rubric = quoted(value[1], child, diagnostics); }
        else if ((value = child.text.match(/^CONFIDENCE (\d+(?:\.\d+)?)$/))) {
            field = 'confidence'; node.confidence = Number(value[1]);
            if (node.confidence < 0 || node.confidence > 1) issue(diagnostics, child, 'invalid-confidence', 'CONFIDENCE must be between 0 and 1 inclusive.');
        } else if (child.text === 'ON UNKNOWN REVIEW') field = 'onUnknown';
        else if (child.text === 'ON REJECT FAILURE') field = 'onReject';
        else { issue(diagnostics, child, 'invalid-interpretation-field', 'Declare QUESTION, USING, LIMIT, EVIDENCE, ACCEPT JEV, CONFIDENCE, ON UNKNOWN REVIEW, or ON REJECT FAILURE.'); continue; }
        if (seen.has(field)) issue(diagnostics, child, 'duplicate-interpretation-field', `${field} is specified more than once.`);
        seen.add(field);
    }
    for (const field of ['question', 'capabilities', 'budget', 'rubric', 'confidence', 'onUnknown', 'onReject']) {
        if (!seen.has(field)) issue(diagnostics, line, 'missing-interpretation-field', `INTERPRET requires an explicit ${field} declaration.`);
    }
    if (!Object.keys(node.evidence).length) issue(diagnostics, line, 'missing-evidence', 'INTERPRET requires at least one EVIDENCE binding.');
    return node;
}

function parseBody(lines, diagnostics) {
    const body = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        let match;
        if ((match = line.text.match(new RegExp(`^RUN (${IDENTIFIER})(?: AS (${NAME}))?:$`)))) {
            const node = { kind: 'run', action: match[1], args: bindings(line, 'WITH', diagnostics), source: location(line) };
            if (match[2]) node.out = match[2];
            body.push(node);
        } else if ((match = line.text.match(new RegExp(`^CHECK (${IDENTIFIER}):$`)))) {
            body.push({ kind: 'check', check: match[1], args: bindings(line, 'WITH', diagnostics), source: location(line) });
        } else if ((match = line.text.match(new RegExp(`^FOR EACH (${NAME}) IN (.+):$`)))) {
            requireBlock(line, diagnostics);
            body.push({ kind: 'for', variable: match[1], items: expression(match[2], line, diagnostics), body: parseBody(line.children, diagnostics), source: location(line) });
        } else if ((match = line.text.match(/^IF (.+):$/))) {
            requireBlock(line, diagnostics);
            const condition = splitCondition(match[1]);
            if (!condition) { issue(diagnostics, line, 'invalid-condition', 'Write IF expression == JSON-literal: or IF expression != JSON-literal:.'); continue; }
            const right = expression(condition[2], line, diagnostics);
            if (right.kind !== 'literal') issue(diagnostics, line, 'condition-literal', 'The right side of an IF comparison must be a JSON literal.');
            const node = { kind: 'if', left: expression(condition[0], line, diagnostics), operator: condition[1], right, then: parseBody(line.children, diagnostics), else: [], source: location(line) };
            if (lines[index + 1]?.text === 'ELSE:') {
                const otherwise = lines[++index];
                requireBlock(otherwise, diagnostics);
                node.else = parseBody(otherwise.children, diagnostics);
            }
            body.push(node);
        } else if ((match = line.text.match(new RegExp(`^INTERPRET (${IDENTIFIER}) AS (${NAME}):$`)))) body.push(interpretation(line, match, diagnostics));
        else if ((match = line.text.match(new RegExp(`^PROVIDE (${NAME}) = (.+)$`)))) {
            requireLeaf(line, diagnostics);
            body.push({ kind: 'provide', name: match[1], value: expression(match[2], line, diagnostics), source: location(line) });
        } else issue(diagnostics, line, line.text === 'ELSE:' ? 'orphan-else' : 'unknown-statement', 'Use RUN, CHECK, FOR EACH, IF / ELSE, INTERPRET, or PROVIDE. Unresolved prose cannot execute.');
    }
    return body;
}

function valueType(value) {
    if (Array.isArray(value)) return 'List';
    if (value !== null && typeof value === 'object') return 'Record';
    return { number: 'Number', string: 'Text', boolean: 'Boolean' }[typeof value] || 'Null';
}

function validate(program, diagnostics) {
    const scope = new Map();
    const outputs = new Map();
    for (const declaration of [...program.inputs, ...program.outputs]) {
        if (scope.has(declaration.name) || outputs.has(declaration.name)) issue(diagnostics, declaration.source, 'duplicate-declaration', `${declaration.name} is already declared.`);
        if (program.inputs.includes(declaration)) scope.set(declaration.name, declaration.type);
        else outputs.set(declaration.name, declaration.type);
    }
    function inspectExpression(expr, visible, source) {
        if (expr.kind === 'literal') return valueType(expr.value);
        if (!visible.has(expr.name)) issue(diagnostics, source, 'undefined-variable', `${expr.name} has no producer in this scope.`);
        return expr.path.length ? undefined : visible.get(expr.name);
    }
    function declare(name, type, visible, source) {
        if (visible.has(name) || outputs.has(name)) issue(diagnostics, source, 'duplicate-producer', `${name} already exists; use a distinct result variable.`);
        visible.set(name, type);
    }
    function argumentsFor(node, metadata, visible) {
        for (const expr of Object.values(node.args)) inspectExpression(expr, visible, node.source);
        if (!metadata) return;
        for (const name of metadata.args) if (!Object.hasOwn(node.args, name)) issue(diagnostics, node.source, 'missing-argument', `Missing WITH ${name} for ${node.action || node.check}.`);
        for (const name of Object.keys(node.args)) if (!metadata.args.includes(name)) issue(diagnostics, node.source, 'unknown-argument', `Unknown argument ${name} for ${node.action || node.check}.`);
    }
    function walk(body, visible, provided, maybeProvided, inLoop = false) {
        for (const node of body) {
            if (node.kind === 'run' || node.kind === 'check') {
                const entries = node.kind === 'run' ? catalog.actions : catalog.checks;
                const name = node.action || node.check;
                const metadata = Object.hasOwn(entries, name) ? entries[name] : undefined;
                if (!metadata) issue(diagnostics, node.source, `unknown-${node.kind === 'run' ? 'action' : 'check'}`, `${name} is not a registered ${node.kind === 'run' ? 'action' : 'check'}.`);
                argumentsFor(node, metadata, visible);
                if (node.out) declare(node.out, metadata?.output, visible, node.source);
            } else if (node.kind === 'interpret') {
                for (const expr of Object.values(node.evidence)) inspectExpression(expr, visible, node.source);
                const capabilities = Array.isArray(catalog.capabilities) ? catalog.capabilities : Object.keys(catalog.capabilities);
                for (const capability of node.capabilities) if (!capabilities.includes(capability)) issue(diagnostics, node.source, 'unknown-capability', `${capability} is not a registered capability.`);
                if (catalog.decisions && !Object.hasOwn(catalog.decisions, node.decision)) issue(diagnostics, node.source, 'unknown-decision', `${node.decision} is not a registered decision.`);
                declare(node.out, catalog.decisions?.[node.decision]?.output, visible, node.source);
            } else if (node.kind === 'for') {
                const type = inspectExpression(node.items, visible, node.source);
                if (type && type !== 'List') issue(diagnostics, node.source, 'loop-type', 'FOR EACH requires a List.');
                const childScope = new Map(visible);
                declare(node.variable, undefined, childScope, node.source);
                walk(node.body, childScope, new Set(provided), new Set(maybeProvided), true);
            } else if (node.kind === 'if') {
                inspectExpression(node.left, visible, node.source);
                inspectExpression(node.right, visible, node.source);
                const yes = walk(node.then, new Map(visible), new Set(provided), new Set(maybeProvided), inLoop);
                const no = walk(node.else, new Map(visible), new Set(provided), new Set(maybeProvided), inLoop);
                for (const name of yes.provided) if (no.provided.has(name)) provided.add(name);
                for (const name of [...yes.maybeProvided, ...no.maybeProvided]) maybeProvided.add(name);
            } else if (node.kind === 'provide') {
                const type = inspectExpression(node.value, visible, node.source);
                if (!outputs.has(node.name)) issue(diagnostics, node.source, 'undeclared-output', `${node.name} is not a declared OUTPUT.`);
                else if (type && type !== outputs.get(node.name)) issue(diagnostics, node.source, 'output-type', `${node.name} requires ${outputs.get(node.name)}, received ${type}.`);
                if (inLoop) issue(diagnostics, node.source, 'output-in-loop', 'PROVIDE must be outside loops so outputs are assigned once.');
                if (maybeProvided.has(node.name)) issue(diagnostics, node.source, 'duplicate-output', `${node.name} may already have been provided on this path.`);
                provided.add(node.name); maybeProvided.add(node.name);
            }
        }
        return { provided, maybeProvided };
    }
    const { provided } = walk(program.body, scope, new Set(), new Set());
    for (const output of program.outputs) if (!provided.has(output.name)) issue(diagnostics, output.source, 'missing-output', `${output.name} must be provided on every successful path.`);
}

function analyze(source) {
    const diagnostics = [];
    if (typeof source !== 'string') throw new TypeError('Sudoc source must be a string.');
    const { roots, lines } = tree(source, diagnostics);
    if (roots.length !== 1 || roots[0]?.text !== '@WORKFLOW:') issue(diagnostics, roots[0] || { number: 1, indent: 0 }, 'workflow-required', 'Declare exactly one top-level @WORKFLOW: block.');
    const program = { inputs: [], outputs: [], failure: 'stop', body: [] };
    const root = roots.find(item => item.text === '@WORKFLOW:');
    if (root) {
        let version = false;
        let failure = false;
        let executing = false;
        const statements = [];
        for (const line of root.children) {
            let match;
            if ((match = line.text.match(/^VERSION (.+)$/))) {
                requireLeaf(line, diagnostics);
                if (executing) issue(diagnostics, line, 'late-declaration', 'Place declarations before executable statements.');
                if (version) issue(diagnostics, line, 'duplicate-version', 'Declare VERSION once.');
                if (match[1] !== '1') issue(diagnostics, line, 'unsupported-version', 'Only VERSION 1 is supported.');
                version = true;
            } else if ((match = line.text.match(declarationPattern))) {
                requireLeaf(line, diagnostics);
                if (executing) issue(diagnostics, line, 'late-declaration', 'Place declarations before executable statements.');
                program[match[1] === 'INPUT' ? 'inputs' : 'outputs'].push({ name: match[2], type: match[3], source: location(line) });
            } else if (line.text === 'ON FAILURE STOP') {
                requireLeaf(line, diagnostics);
                if (executing) issue(diagnostics, line, 'late-declaration', 'Place declarations before executable statements.');
                if (failure) issue(diagnostics, line, 'duplicate-failure', 'Declare ON FAILURE STOP once.');
                failure = true;
            } else { executing = true; statements.push(line); }
        }
        if (!version) issue(diagnostics, root, 'version-required', 'Declare VERSION 1 explicitly.');
        if (!failure) issue(diagnostics, root, 'failure-policy-required', 'Declare ON FAILURE STOP explicitly.');
        if (!statements.length) issue(diagnostics, root, 'empty-workflow', 'Declare at least one executable statement.');
        program.body = parseBody(statements, diagnostics);
        validate(program, diagnostics);
    }
    diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
    return { diagnostics, program: diagnostics.length ? null : program, lines };
}

function format(source) {
    const result = analyze(source);
    if (result.diagnostics.length) {
        const error = new Error('Fix sudoc diagnostics before formatting; indentation determines meaning.');
        error.diagnostics = result.diagnostics;
        throw error;
    }
    const lines = result.lines.map(line => line.text ? '    '.repeat(line.depth) + line.text : '');
    while (lines.at(-1) === '') lines.pop();
    return lines.join('\n') + '\n';
}

module.exports = { analyze, format };
