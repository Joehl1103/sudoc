const fs = require('node:fs');
const path = require('node:path');
const { analyze } = require('./language');
const { resolveCatalog, isAssignable } = require('./catalog');
const own = (object, name) => object && Object.hasOwn(object, name) ? object[name] : undefined;

const WORKFLOW_TEMPLATE = `@WORKFLOW:
    CONTRACT 1
    INPUT $SOURCE AS Text FROM ?
    OUTPUT $RESULT AS Text
    CONDITION $READY AS ?

    DECIDE $READY:
        WHEN true:
            PROVIDE $RESULT = $SOURCE
            EXIT SUCCESS
        WHEN false:
            EXIT FAILURE
        WHEN unknown:
            EXIT REVIEW
`;

function actionTemplate(name, catalog = resolveCatalog()) {
    const action = own(catalog.actions, name);
    if (!action) throw new Error(`Unknown action: ${name}`);
    return [`DO ${name}:`, ...Object.keys(action.arguments).map(arg => `    WITH ${arg} = ?`),
        '    PRODUCES $RESULT', ...action.outcomes.flatMap(outcome => [`    ON ${outcome}:`,
            `        EXIT ${outcome === 'success' ? 'SUCCESS' : outcome === 'failure' ? 'FAILURE' : 'REVIEW'}`]), ''].join('\n');
}

function templateNames() { return ['workflow', 'sms', 'send_sms']; }
function template(name) {
    if (name === 'workflow') return WORKFLOW_TEMPLATE;
    if (name === 'sms') return fs.readFileSync(path.join(__dirname, 'examples', 'sms-contract.workflow'), 'utf8');
    if (name === 'send_sms') return actionTemplate('send_sms');
    throw new Error(`Unknown template ${name}. Choose ${templateNames().join(', ')}.`);
}

function range(line, column, length = 0) { return { line, column, endLine: line, endColumn: column + length }; }
function nodeRange(node, text) {
    const offset = node.text?.indexOf(text) ?? -1;
    return range(node.number, node.indent + 1 + Math.max(0, offset), text.length);
}
function flatten(nodes) { return nodes.flatMap(node => [node, ...flatten(node.children || [])]); }

// Legacy analysis retains prose. The fallback indexes its explicit declarations only.
function legacySymbols(roots, totalLines) {
    const symbols = [];
    function walk(nodes, endLine) {
        nodes.forEach((node, index) => {
            const childEnd = index + 1 < nodes.length ? nodes[index + 1].number - 1 : endLine;
            if (node.declaredVariable) symbols.push({ name: node.declaredVariable, type: 'Text', kind: node.keyword === 'FOR EACH' ? 'loop' : 'definition',
                node, range: nodeRange(node, node.declaredVariable),
                scope: { startLine: node.number + 1, endLine: node.keyword === 'FOR EACH' ? childEnd : endLine } });
            walk(node.children || [], childEnd);
        });
    }
    walk(roots, totalLines);
    return symbols;
}

function model(source, options) {
    const result = analyze(source, options);
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const symbols = result.symbols?.length ? result.symbols : legacySymbols(result.roots, lines.length);
    return { ...result, linesText: lines, symbols, catalog: result.catalog || resolveCatalog(options.catalog) };
}

function scopeContains(symbol, line) {
    const scope = symbol.scope || {};
    return line >= (scope.startLine ?? symbol.range?.line ?? symbol.node?.number ?? 1) && line <= (scope.endLine ?? Infinity);
}
function available(result, line) {
    const indexed = result.availableSymbolsByLine?.[line];
    if (indexed) return indexed instanceof Map ? [...indexed.values()] : Array.isArray(indexed) ? indexed : Object.values(indexed);
    return result.symbols.filter(symbol => (symbol.node?.number ?? symbol.range?.line ?? 0) < line && scopeContains(symbol, line) && symbol.kind !== 'output');
}

function enclosing(result, line, indentation) {
    const stack = [];
    for (const node of flatten(result.roots).filter(node => node.number < line)) {
        while (stack.length && stack.at(-1).indent >= node.indent) stack.pop();
        if (node.block) stack.push(node);
    }
    while (stack.length && stack.at(-1).indent >= indentation) stack.pop();
    return stack;
}

function replacement(prefix, line, column, pattern = /[A-Za-z_][A-Za-z0-9_]*$/) {
    const match = prefix.match(pattern);
    return range(line, column - (match?.[0].length || 0), match?.[0].length || 0);
}

function fieldType(type, fields, catalog) {
    for (const field of fields) type = own(own(catalog.types, type)?.fields, field);
    return type;
}

function insideLiteral(result, line, column) {
    const raw = result.linesText[line - 1] || '';
    if (!/^\s*(?:INPUT|CONDITION|PROVIDE|WITH)\b/i.test(raw) || result.mode !== 'contract') return false;
    let quoted = false;
    let escaped = false;
    for (const character of raw.slice(0, column - 1)) {
        if (escaped) { escaped = false; continue; }
        if (quoted && character === '\\') { escaped = true; continue; }
        if (character === '"') quoted = !quoted;
    }
    return quoted;
}

// Editor positions and ranges are 1-based UTF-16 columns, with exclusive ends.
function complete(source, line, column, options = {}) {
    const result = model(source, options);
    const raw = result.linesText[line - 1];
    if (raw === undefined || column < 1 || column > raw.length + 1) return [];
    const prefix = raw.slice(0, column - 1);
    if (prefix.trimStart().startsWith('#') || insideLiteral(result, line, column)) return [];
    const indentation = prefix.match(/^ */)[0].length;
    const context = enclosing(result, line, indentation);
    const parent = context.at(-1);
    const actionNode = [...context].reverse().find(node => node.keyword === 'DO');
    const actionName = actionNode?.body?.trim();
    const action = own(result.catalog.actions, actionName);
    const values = available(result, line);
    const field = prefix.match(/(\$[A-Z][A-Z0-9_]*)(\.[A-Za-z_][A-Za-z0-9_]*)*\.([A-Za-z0-9_]*)$/);
    const items = [];
    const add = (label, insertText = label, detail = '', kind = 'keyword', editRange = replacement(prefix, line, column)) => {
        items.push({ label, insertText, detail, kind, range: editRange });
    };
    if (field) {
        const symbol = values.find(item => item.name === field[1]);
        const parts = field[0].slice(field[1].length + 1).split('.');
        const partial = parts.pop();
        const type = fieldType(symbol?.type, parts, result.catalog);
        const argument = prefix.match(/^\s*WITH\s+(\w+)\s*=/i)?.[1];
        const expected = action?.arguments[argument]?.type;
        for (const [name, fieldValueType] of Object.entries(result.catalog.types[type]?.fields || {})) {
            if (name.startsWith(partial) && (!expected || isAssignable(fieldValueType, expected, result.catalog) || result.catalog.types[fieldValueType]?.fields)) add(name, name, `${type}.${name}: ${fieldValueType}`, 'field', range(line, column - partial.length, partial.length));
        }
        return items;
    }
    const variable = prefix.match(/\$[A-Za-z0-9_]*$/);
    if (variable) {
        let candidates = values;
        if (/^\s*(?:PROVIDE|PRODUCES)\s+\$[A-Za-z0-9_]*$/i.test(prefix)) candidates = result.symbols.filter(item => item.kind === 'output');
        if (/^\s*DECIDE\s+\$[A-Za-z0-9_]*$/i.test(prefix)) candidates = candidates.filter(item => item.kind === 'condition');
        const argument = prefix.match(/^\s*WITH\s+(\w+)\s*=\s*\$[A-Za-z0-9_]*$/i)?.[1];
        const expected = action?.arguments[argument]?.type;
        for (const symbol of candidates) {
            if (symbol.name.startsWith(variable[0]) && (!expected || isAssignable(symbol.type, expected, result.catalog))) {
                add(symbol.name, symbol.name, `${symbol.type || 'Value'} · ${symbol.kind || 'local'}`, 'variable', range(line, column - variable[0].length, variable[0].length));
            }
            if (expected) {
                const projections = (type, base, depth = 0) => {
                    if (depth >= 4) return;
                    for (const [fieldName, typeName] of Object.entries(result.catalog.types[type]?.fields || {})) {
                        const name = base + '.' + fieldName;
                        if (name.startsWith(variable[0]) && isAssignable(typeName, expected, result.catalog)) {
                            add(name, name, `${typeName} · field of ${symbol.name}`, 'field', range(line, column - variable[0].length, variable[0].length));
                        }
                        projections(typeName, name, depth + 1);
                    }
                };
                projections(symbol.type, symbol.name);
            }
        }
        return items;
    }
    if (/^\s*(?:INPUT|OUTPUT)\s+\$[A-Z][A-Z0-9_]*\s+AS\s+[A-Za-z]*$/i.test(prefix)) {
        const partial = prefix.match(/AS\s+([A-Za-z]*)$/i)[1];
        for (const [name, type] of Object.entries(result.catalog.types)) if (name.startsWith(partial)) add(name, name, type.description, 'type');
        return items;
    }
    if (/^\s*DO\s+[a-z_]*$/i.test(prefix) && result.mode === 'contract') {
        const partial = prefix.match(/DO\s+([a-z_]*)$/i)[1];
        for (const [name, signature] of Object.entries(result.catalog.actions)) {
            if (name.startsWith(partial)) add(name, name + ':', signature.description, 'function');
        }
        return items;
    }
    if (parent?.keyword === 'DO' && /^\s*WITH\s+\w*$/i.test(prefix)) {
        const supplied = new Set((parent.children || []).filter(node => node.keyword === 'WITH' && node.number !== line).map(node => node.body.match(/^\w+/)?.[0]));
        const partial = prefix.match(/WITH\s+(\w*)$/i)[1];
        for (const [name, signature] of Object.entries(action?.arguments || {})) {
            if (!supplied.has(name) && name.startsWith(partial)) add(name, name + ' = ', `${signature.type}${signature.required ? ' (required)' : ''}: ${signature.description || ''}`, 'field');
        }
        return items;
    }
    if (/^\s*(?:WHEN|ON)\s+\w*$/i.test(prefix)) {
        const keyword = prefix.trimStart().split(/\s/)[0].toUpperCase();
        if ((keyword === 'WHEN' && parent?.keyword !== 'DECIDE') || (keyword === 'ON' && parent?.keyword !== 'DO')) return [];
        const supplied = new Set((parent.children || []).filter(node => node.keyword === keyword && node.number !== line).map(node => node.body.toLowerCase()));
        const outcomes = keyword === 'WHEN' ? ['true', 'false', 'unknown'] : action?.outcomes || [];
        const partial = prefix.match(/\s(\w*)$/)[1].toLowerCase();
        for (const outcome of outcomes) if (!supplied.has(outcome) && outcome.startsWith(partial)) add(outcome, outcome + ':', 'Explicit outcome branch', 'enum');
        return items;
    }
    if (/^\s*EXIT\s+[A-Z]*$/i.test(prefix)) {
        for (const name of ['SUCCESS', 'FAILURE', 'REVIEW']) add(name, name, 'End this workflow with an explicit outcome', 'enum');
        return items;
    }
    if (!/^\s*[@A-Za-z ]*$/.test(prefix)) return [];
    const editRange = range(line, indentation + 1, column - indentation - 1);
    const legacy = {
        '@WORKFLOW': '@WORKFLOW:\n    ', DEFINE: 'DEFINE $NAME AS description', 'FOR EACH': 'FOR EACH $RECORD IN source:\n    ',
        WHERE: 'WHERE condition', IF: 'IF condition:\n    ', ELSE: 'ELSE:\n    ', DO: 'DO action', THEN: 'THEN action',
        USING: 'USING tool or approach', NOTE: 'NOTE destination and message', 'STOP RECORD': 'STOP RECORD', 'STOP @WORKFLOW': 'STOP @WORKFLOW',
    };
    const contract = {
        CONTRACT: 'CONTRACT 1', INPUT: 'INPUT $NAME AS Text FROM ?', OUTPUT: 'OUTPUT $RESULT AS Text',
        CONDITION: 'CONDITION $READY AS ?', DECIDE: 'DECIDE $READY:\n    WHEN true:\n        EXIT SUCCESS\n    WHEN false:\n        EXIT FAILURE\n    WHEN unknown:\n        EXIT REVIEW',
        DO: actionTemplate('send_sms', result.catalog).trimEnd(), PROVIDE: 'PROVIDE $RESULT = ?', EXIT: 'EXIT SUCCESS', NOTE: 'NOTE description',
        WITH: 'WITH ', PRODUCES: 'PRODUCES $RESULT', ON: 'ON ', WHEN: 'WHEN ',
    };
    let candidates;
    if (!parent) candidates = { '@WORKFLOW': legacy['@WORKFLOW'] };
    else if (result.mode !== 'contract') {
        candidates = { ...legacy };
        delete candidates['@WORKFLOW'];
        if (parent.keyword === '@WORKFLOW') candidates.CONTRACT = contract.CONTRACT;
        if (parent.keyword !== 'FOR EACH') delete candidates.WHERE;
        if (!context.some(node => node.keyword === 'FOR EACH')) delete candidates['STOP RECORD'];
    }
    else if (parent.keyword === 'DO') candidates = Object.fromEntries(['WITH', 'PRODUCES', 'ON', 'NOTE'].map(key => [key, contract[key]]));
    else if (parent.keyword === 'DECIDE') candidates = { WHEN: contract.WHEN };
    else {
        candidates = { ...contract };
        for (const key of ['WITH', 'PRODUCES', 'ON', 'WHEN']) delete candidates[key];
        if (parent.keyword !== '@WORKFLOW') { delete candidates.CONTRACT; delete candidates.OUTPUT; }
        if (result.linesText.some(text => /^\s*CONTRACT\s+1\s*$/i.test(text))) delete candidates.CONTRACT;
    }
    for (const [label, text] of Object.entries(candidates)) {
        const inserted = text.replace(/\n/g, '\n' + ' '.repeat(indentation));
        add(label, inserted, result.mode === 'contract' ? 'Contract authoring' : 'Legacy structural authoring', 'keyword', editRange);
    }
    return items;
}

function referenceAt(result, line, column) {
    if (result.linesText[line - 1]?.trimStart().startsWith('#') || insideLiteral(result, line, column)) return null;
    const contains = item => item && item.line === line && column >= item.column && column < item.endColumn;
    const ref = result.references?.find(item => contains(item.range || item));
    if (ref) {
        const declaration = ref.symbol || ref.declaration;
        const symbol = typeof declaration === 'string' ? result.symbols.find(item => item.name === declaration) : declaration;
        if (symbol?.range) return { symbol, range: ref.range || ref };
        const candidate = result.symbols.find(item => item.name === ref.name && scopeContains(item, line));
        if (candidate) return { symbol: candidate, range: ref.range || ref };
    }
    const declared = result.symbols.find(item => contains(item.range));
    if (declared) return { symbol: declared, range: declared.range };
    const raw = result.linesText[line - 1] || '';
    for (const match of raw.matchAll(/\$[A-Z][A-Z0-9_]*/g)) {
        if (column >= match.index + 1 && column < match.index + 1 + match[0].length) {
            const symbol = available(result, line).find(item => item.name === match[0]);
            if (symbol) return { symbol, range: range(line, match.index + 1, match[0].length) };
        }
    }
    return null;
}

function definition(source, line, column, options = {}) {
    const found = referenceAt(model(source, options), line, column);
    return found?.symbol.range || null;
}

function hover(source, line, column, options = {}) {
    const result = model(source, options);
    const found = referenceAt(result, line, column);
    if (found) {
        const { symbol } = found;
        const description = result.catalog.types[symbol.type]?.description || '';
        return { contents: `${symbol.name}: ${symbol.type || 'Value'}\n${symbol.kind || 'local'} declared on line ${symbol.range.line}.${description ? '\n' + description : ''}`, range: found.range };
    }
    const raw = result.linesText[line - 1] || '';
    const match = raw.match(/^\s*DO\s+(\w+)/i);
    const actionStart = match ? raw.indexOf(match[1]) + 1 : 0;
    if (match && column >= actionStart && column < actionStart + match[1].length && own(result.catalog.actions, match[1])) {
        const signature = own(result.catalog.actions, match[1]);
        return { contents: `${match[1]}(${Object.entries(signature.arguments).map(([name, arg]) => `${name}: ${arg.type}`).join(', ')}) -> ${signature.output}\n${signature.description}`, range: range(line, raw.indexOf(match[1]) + 1, match[1].length) };
    }
    return null;
}

module.exports = { complete, definition, hover, template, templateNames, actionTemplate };
