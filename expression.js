const { isAssignable } = require('./catalog');

// A deliberately small expression grammar: literals, field references, comparisons,
// NOT, AND, OR, parentheses. No JavaScript evaluation or implicit prose predicates.
function analyzeExpression(source, { resolve, catalog, report }) {
    const tokens = [];
    const pattern = /\s+|\$[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|==|!=|<=|>=|[()<>]|[A-Za-z_][A-Za-z0-9_]*|./gy;
    let match;
    while ((match = pattern.exec(source))) {
        if (!/^\s+$/.test(match[0])) tokens.push({ text: match[0], offset: match.index });
    }
    let index = 0;
    const peek = () => tokens[index]?.text.toUpperCase();
    function error(token, code, message) {
        report(code, message, token?.offset ?? source.length, token?.text.length || 1);
    }
    function primary() {
        const token = tokens[index++];
        if (!token) { error(token, 'invalid-expression', 'Expected a value or parenthesized expression.'); return 'Invalid'; }
        if (token.text === '(') {
            const type = or();
            if (peek() === ')') index += 1;
            else error(tokens[index], 'invalid-expression', 'Close this expression with ).');
            return type;
        }
        if (token.text.startsWith('$')) return resolve(token.text, token.offset);
        if (token.text.startsWith('"')) {
            try { JSON.parse(token.text); return 'Text'; }
            catch { error(token, 'invalid-expression', 'Use a valid double-quoted string.'); return 'Invalid'; }
        }
        if (/^-?\d+(?:\.\d+)?$/.test(token.text)) {
            if (Number.isFinite(Number(token.text))) return 'Number';
            error(token, 'invalid-expression', 'Numbers must be finite.'); return 'Invalid';
        }
        if (/^(true|false)$/i.test(token.text)) return 'Boolean';
        if (/^unknown$/i.test(token.text)) return 'Unknown';
        if (token.text === '?') { error(token, 'unfinished-contract', 'Replace this placeholder with an explicit value.'); return 'Invalid'; }
        error(token, 'invalid-expression', `Unexpected expression token ${token.text}.`);
        return 'Invalid';
    }
    function comparison() {
        const left = primary();
        if (!['==', '!=', '<', '>', '<=', '>='].includes(peek())) return left;
        const operator = tokens[index++];
        const right = primary();
        const ordered = !['==', '!='].includes(operator.text);
        const known = type => !['Unknown', 'Invalid'].includes(type);
        const incompatible = ordered
            ? [left, right].some(type => known(type) && !isAssignable(type, 'Number', catalog))
            : known(left) && known(right) && !isAssignable(left, right, catalog) && !isAssignable(right, left, catalog);
        if (incompatible) error(operator, 'expression-type', `Cannot compare ${left} ${operator.text} ${right}; ordered comparisons require Number operands.`);
        return 'Boolean';
    }
    function booleanOperand(type, token) {
        if (!['Unknown', 'Invalid'].includes(type) && !isAssignable(type, 'Decision', catalog)) error(token, 'expression-type', `Boolean logic requires Boolean or Decision values, received ${type}.`);
    }
    function not() {
        if (peek() !== 'NOT') return comparison();
        const token = tokens[index++];
        booleanOperand(not(), token);
        return 'Boolean';
    }
    function and() {
        let type = not();
        while (peek() === 'AND') {
            const token = tokens[index++];
            booleanOperand(type, token); booleanOperand(not(), token); type = 'Boolean';
        }
        return type;
    }
    function or() {
        let type = and();
        while (peek() === 'OR') {
            const token = tokens[index++];
            booleanOperand(type, token); booleanOperand(and(), token); type = 'Boolean';
        }
        return type;
    }
    const type = or();
    if (index < tokens.length) error(tokens[index], 'invalid-expression', `Unexpected token ${tokens[index].text}; use explicit operators between values.`);
    return type;
}

module.exports = { analyzeExpression };
