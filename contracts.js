const { resolveCatalog, isAssignable } = require('./catalog');
const { analyzeExpression } = require('./expression');

const BLOCKS = new Set(['@WORKFLOW', 'DECIDE', 'WHEN', 'DO', 'ON']);
const PREFIX = /^(@WORKFLOW|CONTRACT|INPUT|OUTPUT|CONDITION|DECIDE|WHEN|DO|WITH|PRODUCES|PROVIDE|ON|EXIT|NOTE)(?=\s|:|$)/i;
const NAME = '\\$[A-Za-z][A-Za-z0-9_]*';

function diagnostic(diagnostics, node, code, message, { token, offset, length, severity = 'error', category = 'contract' } = {}) {
    const position = offset ?? (token ? Math.max(0, node.text.indexOf(token)) : 0);
    const column = node.indent + 1 + position;
    diagnostics.push({ line: node.number, column, endLine: node.number,
        endColumn: column + (length ?? token?.length ?? Math.max(1, node.text.length)), code, message, severity, category });
}

function parseContractStatement(line, diagnostics) {
    const match = line.text.match(PREFIX);
    const keyword = match?.[1].toUpperCase() || '';
    const block = BLOCKS.has(keyword);
    let body = match ? line.text.slice(match[0].length).trim() : line.text;
    const node = { ...line, keyword, body, block, children: [] };
    const invalid = (message, token) => diagnostic(diagnostics, node, 'invalid-contract-syntax', message, { category: 'syntax', token });
    if (!match) { invalid('Use a CONTRACT 1 statement: INPUT, OUTPUT, CONDITION, DECIDE, DO, PROVIDE, NOTE, or EXIT.'); return node; }
    if (block) {
        if (body.endsWith(':')) body = body.slice(0, -1).trim();
        else diagnostic(diagnostics, node, 'missing-colon', `${keyword} opens a block and must end with a colon.`, { category: 'syntax' });
    }
    node.body = body;
    let parsed;
    switch (keyword) {
    case '@WORKFLOW': if (body) invalid('Write @WORKFLOW: without a custom name.'); break;
    case 'CONTRACT': if (body !== '1') invalid('The supported contract version is CONTRACT 1.'); break;
    case 'INPUT':
        parsed = body.match(new RegExp(`^(${NAME})\\s+AS\\s+([A-Za-z][A-Za-z0-9_]*)\\s+FROM\\s+(.+)$`, 'i'));
        if (parsed) Object.assign(node, { name: parsed[1], type: parsed[2], sourceBinding: parsed[3] });
        else invalid('Write INPUT $NAME AS Type FROM "source.path" (or FROM ? while drafting).');
        break;
    case 'OUTPUT':
        parsed = body.match(new RegExp(`^(${NAME})\\s+AS\\s+([A-Za-z][A-Za-z0-9_]*)$`, 'i'));
        if (parsed) Object.assign(node, { name: parsed[1], type: parsed[2] });
        else invalid('Write OUTPUT $NAME AS Type.');
        break;
    case 'CONDITION':
        parsed = body.match(new RegExp(`^(${NAME})\\s+AS\\s+(.+)$`, 'i'));
        if (parsed) Object.assign(node, { name: parsed[1], expression: parsed[2], type: 'Decision' });
        else invalid('Write CONDITION $NAME AS a formal Boolean expression.');
        break;
    case 'DECIDE':
        if (new RegExp(`^${NAME}$`).test(body)) node.name = body;
        else invalid('Write DECIDE $CONDITION: using a named CONDITION.');
        break;
    case 'WHEN':
        node.outcome = body.toLowerCase();
        if (!['true', 'false', 'unknown'].includes(node.outcome)) invalid('Choose WHEN true:, WHEN false:, or WHEN unknown:.');
        break;
    case 'DO':
        if (/^[a-z][a-z0-9_]*$/.test(body)) node.actionName = body;
        else invalid('Write DO action_name: using an action from the catalog. Put explanatory prose in NOTE.');
        break;
    case 'WITH':
        parsed = body.match(/^([a-z][a-z0-9_]*)\s*=\s*(.+)$/);
        if (parsed) Object.assign(node, { argument: parsed[1], expression: parsed[2] });
        else invalid('Write WITH argument = expression.');
        break;
    case 'PRODUCES':
        if (new RegExp(`^${NAME}$`).test(body)) node.name = body;
        else invalid('Write PRODUCES $RESULT; the catalog supplies its type.');
        break;
    case 'PROVIDE':
        parsed = body.match(new RegExp(`^(${NAME})\\s*=\\s*(.+)$`));
        if (parsed) Object.assign(node, { name: parsed[1], expression: parsed[2] });
        else invalid('Write PROVIDE $OUTPUT = expression.');
        break;
    case 'ON': node.outcome = body.toLowerCase(); break;
    case 'EXIT':
        node.outcome = body.toLowerCase();
        if (!['success', 'failure', 'review'].includes(node.outcome)) invalid('Choose EXIT SUCCESS, EXIT FAILURE, or EXIT REVIEW.');
        break;
    case 'NOTE': if (!body) invalid('NOTE needs descriptive text.'); break;
    }
    return node;
}

function checkContracts(roots, diagnostics, options = {}, sourceLines = []) {
    const catalog = resolveCatalog(options.catalog);
    const symbols = [], references = [], conditions = [], actions = [];
    const declared = new Map(), outputSymbols = new Map();
    const contexts = {}, availableSymbolsByLine = {};
    const suiteStates = [];
    const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children)]);
    const statements = flatten(roots);
    const workflows = roots.filter(node => node.keyword === '@WORKFLOW');
    const workflow = workflows[0];
    const report = (node, code, message, details = {}) => diagnostic(diagnostics, node, code, message,
        { ...details, ...(code === 'unfinished-contract' ? { severity: options.strict ? 'error' : 'warning' } : {}) });
    const endLine = node => Math.max(node.number, ...node.children.map(endLine));
    const range = (node, token) => {
        const column = node.indent + 1 + Math.max(0, node.text.indexOf(token));
        return { line: node.number, column, endLine: node.number, endColumn: column + token.length };
    };
    const lexicalEnd = owner => statements.find(node => node.number > owner.number && node.indent <= owner.indent)?.number - 1 || sourceLines.length || endLine(owner);
    const scope = owner => ({ startLine: owner.number, endLine: lexicalEnd(owner) });
    function snapshot(node, env) {
        const entries = [...env.values()].map(entry => ({ ...entry.symbol, available: entry.available }));
        contexts[node.number] = entries;
        availableSymbolsByLine[node.number] = entries.filter(entry => entry.available);
    }
    function register(node, name, type, kind, owner) {
        if (!name) return null;
        if (!/^\$[A-Z][A-Z0-9_]*$/.test(name)) report(node, 'invalid-variable-name', `${name} must use uppercase letters, numbers, and underscores.`, { token: name });
        if (!Object.hasOwn(catalog.types, type)) report(node, 'unknown-type', `Unknown type ${type}; add it to the domain catalog.`, { token: type });
        if (declared.has(name)) { report(node, 'duplicate-variable', `${name} is already declared in this workflow.`, { token: name }); return null; }
        const symbol = { name, type, kind, node, range: range(node, name), scope: scope(owner) };
        symbols.push(symbol); declared.set(name, symbol); return symbol;
    }
    function resolve(node, text, env, offset = node.text.indexOf(text)) {
        const [name, ...fields] = text.split('.');
        const entry = env.get(name);
        references.push({ name, type: entry?.symbol.type, ...range(node, name), column: node.indent + 1 + offset,
            endColumn: node.indent + 1 + offset + text.length, declaration: entry?.symbol.range, symbol: entry?.symbol });
        if (!entry) { report(node, 'undefined-variable', `${name} is not declared in this scope.`, { offset, length: name.length }); return 'Invalid'; }
        if (!entry.available) report(node, 'unavailable-output', `${name} has no value on this path; declarations are not producers.`, { offset, length: name.length });
        let type = entry.symbol.type;
        let fieldOffset = offset + name.length + 1;
        for (const field of fields) {
            const fields = catalog.types[type]?.fields;
            const next = fields && Object.hasOwn(fields, field) ? fields[field] : undefined;
            if (!next) { report(node, 'unknown-field', `${type} has no field ${field}.`, { offset: fieldOffset, length: field.length }); return 'Invalid'; }
            type = typeof next === 'string' ? next : next.type;
            fieldOffset += field.length + 1;
        }
        return type;
    }
    function expression(node, env) {
        if (!node.expression) return 'Invalid';
        const delimiter = node.keyword === 'CONDITION' ? /\s+AS\s+/i.exec(node.text) : /\s*=\s*/.exec(node.text);
        const start = delimiter ? delimiter.index + delimiter[0].length : node.text.indexOf(node.expression);
        return analyzeExpression(node.expression, { catalog,
            resolve: (text, offset) => resolve(node, text, env, start + offset),
            report: (code, message, offset, length) => report(node, code, message, { offset: start + offset, length }),
        });
    }
    function typeCheck(node, actual, expected) {
        if (!isAssignable(actual, expected, catalog)) report(node, 'type-mismatch', `Expected ${expected}, received ${actual}.`, { token: node.expression });
    }
    function join(states, incoming) {
        const active = states.filter(Boolean);
        if (!active.length) return null;
        // Branch-local declarations stay local. Outer outputs become available only
        // when every continuing path provides them (terminal failure paths excluded).
        return new Map([...incoming].map(([name, entry]) => [name, { ...entry, available: active.every(state => state.get(name)?.available) }]));
    }
    function branchSet(node, branches, expected) {
        for (const outcome of expected) if (!branches.some(branch => branch.outcome === outcome)) report(node, 'missing-outcome', `${node.keyword} requires an explicit ${outcome} branch.`);
        const seen = new Set();
        for (const branch of branches) {
            if (!expected.includes(branch.outcome)) report(branch, 'invalid-outcome', `Expected one of: ${expected.join(', ')}.`);
            if (seen.has(branch.outcome)) report(branch, 'duplicate-outcome', `Handle ${branch.outcome} exactly once.`);
            seen.add(branch.outcome);
        }
    }
    function checkNote(node, env) {
        for (const match of node.body.matchAll(/\$[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*/g)) resolve(node, match[0], env, node.text.indexOf(node.body) + match.index);
        for (const match of node.body.matchAll(/(?:^|[^A-Za-z0-9._%+-])(@[A-Za-z][A-Za-z0-9_]*)/g)) {
            if (match[1] !== '@WORKFLOW') report(node, 'undefined-workflow', `${match[1]} is not defined. This file's global workflow is @WORKFLOW.`, { token: match[1] });
        }
    }
    function action(node, env, reachable = true) {
        actions.push(node);
        suiteStates.push({ owner: node, states: [{ line: node.number, env: new Map(env) }] });
        const specification = Object.hasOwn(catalog.actions, node.actionName) ? catalog.actions[node.actionName] : undefined;
        if (!specification) report(node, 'unknown-action', `Unknown action ${node.actionName || node.body}; add it to the domain catalog.`, { token: node.actionName });
        const args = node.children.filter(child => child.keyword === 'WITH');
        const producers = node.children.filter(child => child.keyword === 'PRODUCES');
        const branches = node.children.filter(child => child.keyword === 'ON');
        for (const child of node.children) {
            child.reachable = reachable;
            snapshot(child, env);
            if (!['WITH', 'PRODUCES', 'ON', 'NOTE'].includes(child.keyword)) report(child, 'invalid-placement', 'Inside DO, use WITH, PRODUCES, NOTE, and ON outcome branches.');
            if (child.keyword === 'NOTE') checkNote(child, env);
        }
        const seen = new Set();
        for (const arg of args) {
            const actual = expression(arg, env), expected = specification && Object.hasOwn(specification.arguments, arg.argument) ? specification.arguments[arg.argument] : undefined;
            if (seen.has(arg.argument)) report(arg, 'duplicate-argument', `${arg.argument} is already bound.`);
            seen.add(arg.argument);
            if (!expected && specification) report(arg, 'unknown-argument', `${node.actionName} has no argument ${arg.argument}.`, { token: arg.argument });
            if (expected) typeCheck(arg, actual, expected.type);
        }
        for (const [name, spec] of Object.entries(specification?.arguments || {})) if (spec.required !== false && !seen.has(name)) report(node, 'missing-argument', `${node.actionName} requires WITH ${name} = expression.`);
        if (specification?.output && producers.length !== 1) report(node, 'missing-production', `${node.actionName} requires exactly one PRODUCES $RESULT binding.`);
        let target;
        const producer = producers[0];
        if (producer?.name && specification?.output) {
            target = env.get(producer.name)?.symbol;
            if (target) {
                if (target.kind !== 'output') report(producer, 'invalid-production', 'PRODUCES may bind an OUTPUT or introduce a new local result; inputs and conditions are immutable.');
                typeCheck({ ...producer, expression: producer.name }, specification.output, target.type);
                references.push({ name: producer.name, type: target.type, ...range(producer, producer.name), declaration: target.range, symbol: target, write: true });
            } else {
                target = register(producer, producer.name, specification.output, 'result', node);
            }
        }
        const expected = specification?.outcomes || ['success', 'failure', 'unknown'];
        branchSet(node, branches, expected);
        const states = branches.map(branch => {
            const branchEnv = new Map(env);
            if (branch.outcome === 'success' && target) branchEnv.set(target.name, { symbol: target, available: true });
            snapshot(branch, branchEnv);
            return suite(branch.children, branchEnv, branch, reachable);
        });
        // Missing outcomes are unknown paths, never an excuse to infer production.
        if (expected.some(outcome => !branches.some(branch => branch.outcome === outcome))) states.push(env);
        return join(states, env);
    }
    function suite(nodes, inherited, owner, reachable = true) {
        let env = new Map(inherited);
        const states = [{ line: owner.number, env: new Map(env) }];
        suiteStates.push({ owner, states });
        let terminated = false;
        for (const node of nodes) {
            node.reachable = reachable && !terminated;
            snapshot(node, env);
            if (terminated) report(node, 'unreachable', 'This statement follows an exit on every path.', { severity: 'warning' });
            switch (node.keyword) {
            case 'CONTRACT': if (owner.keyword !== '@WORKFLOW') report(node, 'invalid-placement', 'CONTRACT belongs directly inside @WORKFLOW.'); break;
            case 'INPUT': {
                if (!node.name) break;
                if (node.sourceBinding === '?') report(node, 'unfinished-contract', 'Bind this input to an explicit source.', { token: '?' });
                else {
                    try {
                        const binding = JSON.parse(node.sourceBinding);
                        if (typeof binding !== 'string' || !binding.trim()) throw new Error();
                        node.source = binding;
                    } catch { report(node, 'invalid-source', 'FROM must name a nonempty double-quoted external source, or ? while drafting.', { token: node.sourceBinding }); }
                }
                const symbol = register(node, node.name, node.type, 'input', owner);
                if (symbol) env.set(symbol.name, { symbol, available: true });
                break;
            }
            case 'OUTPUT':
                if (owner.keyword !== '@WORKFLOW') report(node, 'invalid-placement', 'OUTPUT belongs directly inside @WORKFLOW.');
                break;
            case 'CONDITION': {
                conditions.push(node);
                const type = expression(node, env);
                if (!['Unknown', 'Invalid'].includes(type) && !isAssignable(type, 'Decision', catalog)) report(node, 'condition-type', `A condition requires a Boolean expression, received ${type}.`);
                const symbol = register(node, node.name, 'Decision', 'condition', owner);
                if (symbol) env.set(symbol.name, { symbol, available: true });
                break;
            }
            case 'DECIDE': {
                suiteStates.push({ owner: node, states: [{ line: node.number, env: new Map(env) }] });
                if (node.name) {
                    resolve(node, node.name, env);
                    if (env.get(node.name) && env.get(node.name).symbol.kind !== 'condition') report(node, 'condition-required', 'DECIDE must reference a named CONDITION.');
                }
                const branches = node.children.filter(child => child.keyword === 'WHEN');
                for (const child of node.children) if (child.keyword !== 'WHEN') report(child, 'invalid-placement', 'DECIDE contains WHEN true, false, and unknown branches.');
                branchSet(node, branches, ['true', 'false', 'unknown']);
                const states = branches.map(branch => { branch.reachable = node.reachable; snapshot(branch, env); return suite(branch.children, env, branch, node.reachable); });
                if (['true', 'false', 'unknown'].some(outcome => !branches.some(branch => branch.outcome === outcome))) states.push(env);
                const next = join(states, env);
                if (!next) terminated = true; else env = next;
                break;
            }
            case 'DO': {
                const next = action(node, env, node.reachable);
                if (!next) terminated = true; else env = next;
                break;
            }
            case 'PROVIDE': {
                const type = expression(node, env), target = env.get(node.name);
                if (!target || target.symbol.kind !== 'output') report(node, 'output-required', 'PROVIDE must bind a declared OUTPUT.', { token: node.name });
                else {
                    typeCheck(node, type, target.symbol.type);
                    references.push({ name: node.name, type: target.symbol.type, ...range(node, node.name), declaration: target.symbol.range, symbol: target.symbol, write: true });
                    env.set(node.name, { ...target, available: true });
                }
                break;
            }
            case 'EXIT':
                if (node.outcome === 'success' && node.reachable) for (const [name] of outputSymbols) if (!env.get(name)?.available) report(node, 'missing-output', `Successful exit must produce ${name}.`);
                terminated = true;
                break;
            case 'NOTE': checkNote(node, env); break;
            default: if (node.keyword) report(node, 'invalid-placement', `${node.keyword} is not a statement in this suite.`);
            }
            states.push({ line: endLine(node), env: new Map(env) });
        }
        return terminated ? null : env;
    }
    if (workflow) {
        const headers = workflow.children.filter(node => node.keyword === 'CONTRACT');
        if (headers.length !== 1 || headers[0]?.body !== '1') report(workflow, 'contract-required', 'Declare exactly one CONTRACT 1 directly inside @WORKFLOW.');
        if (workflow.children.find(node => node.keyword !== 'NOTE')?.keyword !== 'CONTRACT') report(workflow, 'contract-position', 'CONTRACT 1 must be the first non-NOTE statement.');
        const env = new Map();
        for (const node of workflow.children.filter(node => node.keyword === 'OUTPUT')) {
            const symbol = register(node, node.name, node.type, 'output', workflow);
            if (symbol) { outputSymbols.set(symbol.name, symbol); env.set(symbol.name, { symbol, available: false }); }
        }
        if (!workflow.children.some(node => node.keyword === 'INPUT')) report(workflow, 'input-required', 'Declare at least one explicit INPUT and source binding.');
        if (!outputSymbols.size) report(workflow, 'output-required', 'Declare at least one explicit OUTPUT.');
        const remaining = suite(workflow.children, env, workflow);
        if (!conditions.some(node => node.reachable)) report(workflow, 'condition-required', 'Declare at least one reachable explicit CONDITION.');
        if (remaining) report(workflow, 'missing-exit', 'Every path must terminate with EXIT SUCCESS, EXIT FAILURE, or EXIT REVIEW.');
    }
    // Completion on blank/comment lines uses the same path state as a new statement
    // at that indentation, including produced outputs inside ON success.
    for (const line of sourceLines) {
        if (contexts[line.number]) continue;
        const candidates = suiteStates.filter(item => item.owner.number < line.number && lexicalEnd(item.owner) >= line.number && item.owner.indent < line.indent);
        candidates.sort((left, right) => right.owner.indent - left.owner.indent);
        const selected = candidates[0];
        if (selected) {
            const state = selected.states.filter(item => item.line < line.number).at(-1);
            if (state) snapshot(line, state.env);
        }
    }
    return { symbols, references, catalog, conditions, actions, contexts, availableSymbolsByLine };
}

module.exports = { parseContractStatement, checkContracts };
