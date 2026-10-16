'use strict';

const { createHash } = require('node:crypto');
const { analyze } = require('./sudoc-language');

// Canonical JSON gives contracts a stable identity without erasing extra fields.
function canonical(value, ancestors = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? '-0' : JSON.stringify(value);
    if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Expected finite, acyclic JSON data.');
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Symbol fields are not JSON data.');
    const next = new Set(ancestors).add(value);
    if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index))) throw new TypeError('Expected a dense JSON array.');
        return '[' + value.map(item => canonical(item, next)).join(',') + ']';
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Expected a plain JSON object.');
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], next)).join(',') + '}';
}

function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}

function contractHash(program) {
    return hash(canonical(program));
}

function compile(source) {
    const { diagnostics, program } = analyze(source);
    if (diagnostics.length) {
        const error = new Error('Sudoc compilation failed: ' + diagnostics.map(item => `${item.line}:${item.column} ${item.message}`).join('\n'));
        error.diagnostics = diagnostics;
        throw error;
    }
    return { format: 'sudoc-ir', version: 1, sourceHash: hash(source), contractHash: contractHash(program), program };
}

// The verifier does not call compile or trust the artifact's hashes. It re-parses
// the source contract and checks the entire supported lowering independently.
// This is structural preservation, not a theorem prover or proof of model truth.
function verify(source, artifact) {
    const { diagnostics: sourceDiagnostics, program } = analyze(source);
    const diagnostics = [...sourceDiagnostics];
    function reject(code, message) { diagnostics.push({ line: 1, column: 1, code, message, severity: 'error' }); }
    if (!program) return { valid: false, diagnostics };
    try {
        if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new TypeError('The compiled artifact must be an object.');
        canonical(artifact);
        const keys = Object.keys(artifact).sort();
        if (canonical(keys) !== canonical(['contractHash', 'format', 'program', 'sourceHash', 'version'])) reject('artifact-fields', 'The artifact contains missing or unauthorized top-level fields.');
        if (artifact.format !== 'sudoc-ir' || artifact.version !== 1) reject('artifact-version', 'Expected sudoc-ir version 1.');
        if (artifact.sourceHash !== hash(source)) reject('stale-source', 'The artifact does not identify this exact source.');
        if (canonical(artifact.program) !== canonical(program)) reject('contract-mismatch', 'The runtime program differs from the source contract: an obligation, action, argument, control edge, source location, or freedom boundary changed.');
        if (artifact.contractHash !== contractHash(program) || artifact.contractHash !== contractHash(artifact.program)) reject('contract-hash', 'The contract hash does not match the independently parsed source and runtime program.');
    } catch (error) { reject('invalid-artifact', error.message); }
    return { valid: diagnostics.length === 0, diagnostics };
}

module.exports = { compile, verify, canonical, hash, contractHash };
