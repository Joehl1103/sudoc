const BLOCK_KEYWORDS = new Set(['@WORKFLOW', 'FOR EACH', 'IF', 'ELSE']);
const KEYWORD_PATTERN = /^(@WORKFLOW|FOR\s+EACH|DEFINE|USING|WHERE|DO|THEN|IF|ELSE|NOTE|STOP)(?=\s|:|$)/i;
const VARIABLE_REFERENCE_PATTERN = /\$[A-Za-z][A-Za-z0-9_]*/g;
const VALID_VARIABLE_NAME_PATTERN = /^\$[A-Z][A-Z0-9_]*$/;
const WORKFLOW_REFERENCE_PATTERN = /(?:^|[^A-Za-z0-9._%+-])(@[A-Za-z][A-Za-z0-9_]*)/g;
const { parseContractStatement, checkContracts } = require('./contracts');

// Diagnostics use one-based positions so the CLI and editor share one contract.
function report(diagnostics, line, code, message, severity = 'error') {
    diagnostics.push({
        line: line.number,
        column: line.indent + 1,
        endLine: line.number,
        endColumn: line.indent + 1 + Math.max(1, line.text?.length || 1),
        code,
        message,
        severity,
        category: 'syntax',
    });
}

// Only the fixed prefix is parsed. Action text and predicates remain opaque prose.
function parseStatement(line, diagnostics) {
    const match = line.text.match(KEYWORD_PATTERN);
    if (!match) {
        report(diagnostics, line, 'unknown-statement', 'Start with @WORKFLOW, DEFINE, DO, THEN, IF, ELSE, FOR EACH, WHERE, USING, NOTE, or STOP.');
        return { ...line, keyword: '', body: line.text, block: false, children: [] };
    }

    const keyword = match[1].replace(/\s+/g, ' ').toUpperCase();
    const block = BLOCK_KEYWORDS.has(keyword);
    let body = line.text.slice(match[0].length).trim();
    if (block) {
        if (!body.endsWith(':')) {
            report(diagnostics, line, 'missing-colon', `${keyword} opens a block and must end with a colon.`);
        } else {
            body = body.slice(0, -1).trim();
        }
    }

    if (keyword === '@WORKFLOW') {
        if (body !== '') {
            report(diagnostics, line, 'invalid-workflow-name', 'Write @WORKFLOW: without a custom name. The filename provides the title.');
        }
    } else if (keyword === 'ELSE') {
        if (body !== '') {
            report(diagnostics, line, 'else-text', 'Write ELSE: without a condition. Nest another IF inside it if needed.');
        }
    } else if (keyword === 'STOP') {
        if (/^RECORD$/i.test(body)) {
            body = 'RECORD';
        } else if (/^@WORKFLOW$/i.test(body)) {
            body = '@WORKFLOW';
        } else if (!/^@[A-Za-z][A-Za-z0-9_]*$/.test(body)) {
            report(diagnostics, line, 'stop-scope', 'Choose STOP RECORD or STOP @WORKFLOW.');
        }
    } else if (body === '') {
        report(diagnostics, line, 'missing-text', `${keyword} needs descriptive text.`);
    }

    let declaredVariable = null;
    let referencedText = body;
    if (keyword === '@WORKFLOW') {
        referencedText = '';
    }

    if (keyword === 'DEFINE') {
        const definition = body.match(/^(\$[A-Za-z][A-Za-z0-9_]*)\s+AS\s+(.+)$/i);
        if (!definition) {
            report(diagnostics, line, 'invalid-definition', 'Write DEFINE $NAME AS description.');
            referencedText = '';
        } else {
            declaredVariable = definition[1];
            referencedText = definition[2];
            body = `${declaredVariable} AS ${referencedText}`;
        }
    }

    if (keyword === 'FOR EACH') {
        const loop = body.match(/^(\$[A-Za-z][A-Za-z0-9_]*)\s+IN\s+(.+)$/i);
        if (!loop) {
            report(diagnostics, line, 'invalid-loop', 'Write FOR EACH $RECORD IN source:');
            referencedText = '';
        } else {
            declaredVariable = loop[1];
            referencedText = loop[2];
            body = `${loop[1]} IN ${loop[2]}`;
        }
    }

    if (keyword === 'IF' && /^(THIS|IT) IS (TRUE|FALSE|YES|NO)$/i.test(body)) {
        report(diagnostics, line, 'vague-condition', 'Name the condition so its meaning survives edits.', 'warning');
    }

    return { ...line, keyword, body, block, declaredVariable, referencedText, children: [] };
}

// Ignore @ inside email addresses while collecting explicit workflow references.
function workflowReferences(text) {
    const references = [];
    const matches = text.matchAll(WORKFLOW_REFERENCE_PATTERN);

    for (const match of matches) {
        references.push(match[1]);
    }

    return references;
}

// @WORKFLOW is the only file-wide object; all other @ references are undefined.
function checkWorkflowReferences(nodes, diagnostics) {
    for (const node of nodes) {
        const referencedText = node.referencedText || '';
        const references = new Set(workflowReferences(referencedText));

        for (const name of references) {
            if (name !== '@WORKFLOW') {
                report(diagnostics, node, 'undefined-workflow', `${name} is not defined. This file's global workflow is @WORKFLOW.`);
            }
        }

        checkWorkflowReferences(node.children, diagnostics);
    }
}

// Variable names stay visually distinct from prose and consistent across files.
function checkVariableName(node, name, diagnostics) {
    if (VALID_VARIABLE_NAME_PATTERN.test(name)) {
        return true;
    }

    report(diagnostics, node, 'invalid-variable-name', `${name} must use uppercase letters, numbers, and underscores.`);
    return false;
}

// References resolve only to earlier declarations in the current or an outer block.
function checkVariableReferences(node, visibleVariables, diagnostics) {
    const referencedText = node.referencedText || '';
    const references = referencedText.match(VARIABLE_REFERENCE_PATTERN) || [];
    const uniqueReferences = new Set(references);

    for (const name of uniqueReferences) {
        if (!checkVariableName(node, name, diagnostics)) {
            continue;
        }

        const declaration = visibleVariables.get(name);
        if (!declaration) {
            report(diagnostics, node, 'undefined-variable', `${name} is not defined here. Define it earlier in this block or an outer block.`);
            continue;
        }

        declaration.uses += 1;
    }
}

// Declarations are unique across a workflow so the same name never changes meaning.
function registerVariable(node, declarations, diagnostics) {
    const name = node.declaredVariable;
    if (!name || !checkVariableName(node, name, diagnostics)) {
        return null;
    }

    if (declarations.has(name)) {
        report(diagnostics, node, 'duplicate-variable', `${name} is already defined in this workflow.`);
        return null;
    }

    const declaration = { name, node, uses: 0 };
    declarations.set(name, declaration);
    return declaration;
}

// Walk each ordered suite with a copy of the variables inherited from its parent.
function checkVariables(nodes, inheritedVariables, declarations, diagnostics) {
    const visibleVariables = new Map(inheritedVariables);

    for (const node of nodes) {
        checkVariableReferences(node, visibleVariables, diagnostics);

        if (node.keyword === 'DEFINE') {
            const declaration = registerVariable(node, declarations, diagnostics);
            if (declaration) {
                visibleVariables.set(declaration.name, declaration);
            }
        }

        const childVariables = new Map(visibleVariables);
        if (node.keyword === 'FOR EACH') {
            const declaration = registerVariable(node, declarations, diagnostics);
            if (declaration) {
                childVariables.set(declaration.name, declaration);
            }
        }

        checkVariables(node.children, childVariables, declarations, diagnostics);
    }
}

// Attach a line to the suite selected by its indentation; never repair bad nesting.
function chooseFrame(node, frames, previous, diagnostics) {
    let frame = frames[frames.length - 1];
    if (node.indent > frame.indent) {
        if (!previous || !previous.block) {
            report(diagnostics, node, 'unexpected-indent', 'Only a block header ending in : can introduce indentation.');
        } else {
            frame = { indent: node.indent, owner: previous, children: previous.children };
            frames.push(frame);
        }
    } else {
        while (frames.length > 1 && node.indent < frame.indent) {
            frames.pop();
            frame = frames[frames.length - 1];
        }
        if (node.indent !== frame.indent) {
            report(diagnostics, node, 'invalid-dedent', 'Dedent to an existing outer indentation level.');
        }
    }
    return frame;
}

// Comments do not open/close suites. Their whitespace selects the nearest scope.
function commentDepth(line, frames, previous) {
    if (previous && previous.block && line.indent > previous.indent) {
        return previous.depth + 1;
    }
    for (let index = frames.length - 1; index >= 0; index -= 1) {
        if (line.indent >= frames[index].indent) {
            return index;
        }
    }
    return 0;
}

// These checks use the indentation tree; they do not evaluate business conditions.
function checkStructure(node, frame, frames, diagnostics) {
    const siblings = frame.children;
    const previousSibling = siblings[siblings.length - 1];
    if (node.keyword === '@WORKFLOW' && frame.owner) {
        report(diagnostics, node, 'nested-workflow', '@WORKFLOW belongs at the top level.');
    }
    if (!frame.owner && node.keyword !== '@WORKFLOW') {
        report(diagnostics, node, 'outside-workflow', 'Indent this statement inside @WORKFLOW.');
    }
    if (node.keyword === 'ELSE' && (!previousSibling || previousSibling.keyword !== 'IF')) {
        report(diagnostics, node, 'orphan-else', 'ELSE must immediately follow an IF block at the same indentation.');
    }
    if (node.keyword === 'WHERE' && (!frame.owner || frame.owner.keyword !== 'FOR EACH' || siblings.length !== 0)) {
        report(diagnostics, node, 'where-position', 'WHERE must be the first statement directly inside FOR EACH.');
    }
    const insideLoop = frames.some(item => item.owner && item.owner.keyword === 'FOR EACH');
    if (node.keyword === 'STOP' && node.body === 'RECORD' && !insideLoop) {
        report(diagnostics, node, 'record-outside-loop', 'STOP RECORD needs an enclosing FOR EACH loop.');
    }
    if (siblings.some(item => item.keyword === 'STOP')) {
        report(diagnostics, node, 'unreachable', 'This statement follows STOP in the same block.', 'warning');
    }
}

// Build a small tree and retain source-line metadata for loss-minimizing formatting.
function analyze(source, options = {}) {
    const mode = /^\s*CONTRACT\b/im.test(source) ? 'contract' : 'legacy';
    const diagnostics = [];
    const roots = [];
    const statements = [];
    const lines = [];
    const frames = [{ indent: 0, owner: null, children: roots }];
    const sourceLines = source.replace(/\r\n?/g, '\n').split('\n');
    let previous = null;

    for (let index = 0; index < sourceLines.length; index += 1) {
        const raw = sourceLines[index];
        const whitespace = raw.match(/^\s*/)[0];
        const line = { number: index + 1, indent: whitespace.length, text: raw.trim(), depth: 0 };
        if (line.text === '') {
            lines.push({ ...line, kind: 'blank' });
            continue;
        }
        if (whitespace.includes('\t')) {
            report(diagnostics, line, 'tabs', 'Use spaces for indentation; tabs are ambiguous.');
        }
        if (line.text.startsWith('#')) {
            line.depth = commentDepth(line, frames, previous);
            lines.push({ ...line, kind: 'comment' });
            continue;
        }

        const node = mode === 'contract' ? parseContractStatement(line, diagnostics) : parseStatement(line, diagnostics);
        if (!previous && node.indent !== 0) {
            report(diagnostics, node, 'root-indent', 'The @WORKFLOW header must begin in column 1.');
        }
        const frame = chooseFrame(node, frames, previous, diagnostics);
        node.depth = frames.length - 1;
        checkStructure(node, frame, frames, diagnostics);
        frame.children.push(node);
        statements.push(node);
        lines.push({ ...node, kind: 'statement' });
        previous = node;
    }

    for (const node of statements) {
        if (node.block && node.children.length === 0) {
            report(diagnostics, node, 'empty-block', `${node.keyword} needs at least one indented statement.`);
        }
    }
    const workflows = roots.filter(node => node.keyword === '@WORKFLOW');
    const firstLine = { number: 1, indent: 0 };
    if (workflows.length === 0) {
        report(diagnostics, firstLine, 'workflow-required', 'Start the document with @WORKFLOW:');
    } else if (workflows.length > 1) {
        report(diagnostics, workflows[1], 'workflow-count', 'Use one @WORKFLOW per file.');
    }
    let services;
    if (mode === 'contract') {
        services = checkContracts(roots, diagnostics, options, lines);
    } else {
        checkWorkflowReferences(roots, diagnostics);
        const declarations = new Map();
        checkVariables(roots, new Map(), declarations, diagnostics);
        for (const declaration of declarations.values()) {
            if (declaration.uses === 0) {
                report(diagnostics, declaration.node, 'unused-variable', `${declaration.name} is defined but never used.`, 'warning');
            }
        }
        const endLine = node => Math.max(node.number, ...node.children.map(endLine));
        const symbols = [], references = [];
        const lexicalEnd = owner => statements.find(node => node.number > owner.number && node.indent <= owner.indent)?.number - 1 || sourceLines.length;
        const range = (node, name) => ({ line: node.number, column: node.indent + 1 + Math.max(0, node.text.indexOf(name)), endLine: node.number, endColumn: node.indent + 1 + Math.max(0, node.text.indexOf(name)) + name.length });
        const walk = (nodes, owner, inherited) => {
            const visible = new Map(inherited);
            for (const node of nodes) {
                for (const match of (node.referencedText || '').matchAll(VARIABLE_REFERENCE_PATTERN)) {
                    const symbol = visible.get(match[0]);
                    references.push({ name: match[0], ...range(node, match[0]), declaration: symbol?.range, symbol });
                }
                const childScope = new Map(visible);
                if (node.declaredVariable) {
                    const scopeOwner = node.keyword === 'FOR EACH' ? node : owner;
                    const symbol = { name: node.declaredVariable, type: 'Any', kind: node.keyword === 'FOR EACH' ? 'loop' : 'definition', node,
                        range: range(node, node.declaredVariable), scope: { startLine: scopeOwner?.number || 1, endLine: scopeOwner ? lexicalEnd(scopeOwner) : sourceLines.length } };
                    symbols.push(symbol);
                    childScope.set(symbol.name, symbol);
                    if (node.keyword !== 'FOR EACH') visible.set(symbol.name, symbol);
                }
                walk(node.children, node, childScope);
            }
        };
        walk(roots, null, new Map());
        services = { symbols, references };
        if (options.strict) diagnostics.push({ line: 1, column: 1, endLine: 1, endColumn: 11, category: 'contract', code: 'contract-required', severity: 'error', message: 'Legacy workflows are supported for authoring. Migrate explicitly to CONTRACT 1 before readiness validation.' });
    }

    diagnostics.sort((first, second) => first.line - second.line || first.column - second.column);
    return { roots, lines, diagnostics, mode, ready: mode === 'contract' && !diagnostics.some(item => item.severity === 'error' || item.code === 'unfinished-contract'), ...services };
}

// Formatting only succeeds when hierarchy is unambiguous. Prose stays unchanged.
function format(source) {
    const result = analyze(source);
    if (result.diagnostics.some(item => item.severity === 'error' && item.category === 'syntax')) {
        throw new Error('Fix syntax errors before formatting; indentation determines meaning.');
    }
    const output = result.lines.map(line => {
        if (line.kind === 'blank') {
            return '';
        }
        const indentation = '    '.repeat(line.depth);
        if (line.kind === 'comment') {
            return indentation + line.text;
        }
        let text = line.keyword;
        if (line.body !== '') {
            text += ' ' + line.body;
        }
        if (line.block) {
            text += ':';
        }
        return indentation + text;
    });
    while (output.length > 0 && output[output.length - 1] === '') {
        output.pop();
    }
    return output.join('\n') + '\n';
}

module.exports = { analyze, format };
