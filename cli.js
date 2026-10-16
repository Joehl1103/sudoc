#!/usr/bin/env node
const fs = require('node:fs');

function authoring(source) {
    return /^\s*VERSION\b/im.test(source) ? require('./sudoc-language') : require('./language');
}

function read(filename) {
    const contents = fs.readFileSync(filename === '-' ? 0 : filename, 'utf8');
    if (Buffer.byteLength(contents, 'utf8') > 4194304) throw new Error('Input exceeds the 4 MiB limit.');
    return contents;
}

function usage() {
    console.error('Usage: node cli.js lint <source|-> [--json] | format <source|-> [--write]\n' +
        '       node cli.js compile <source> [--out <artifact.json>] | inspect <source> [--json]\n' +
        '       node cli.js verify <source> <artifact.json>\n' +
        '       node cli.js run <source> <artifact.json> --fixture <fixture.json> [--live-jev] [--model <pinned-version>]');
    return 2;
}

function json(value) { console.log(JSON.stringify(value, null, 2)); }

function expression(value) {
    return value.kind === 'literal' ? JSON.stringify(value.value) : value.name + value.path.map(field => '.' + field).join('');
}

function describe(artifact, source) {
    const { actions, checks } = require('./sudoc-catalog');
    const lines = source.split(/\r?\n/);
    const obligations = [];
    function walk(nodes, depth = 0, branches = []) {
        for (const node of nodes) {
            const location = node.source;
            const item = { kind: node.kind, line: location.line, depth, branches, source: lines[location.line - 1]?.trim() };
            if (node.args) item.bindings = Object.fromEntries(Object.entries(node.args).map(([name, value]) => [name, expression(value)]));
            if (node.kind === 'run') item.meaning = actions[node.action]?.description || `Execute registered action ${node.action}.`;
            if (node.kind === 'check') item.meaning = checks[node.check]?.description || `Require registered check ${node.check} to pass.`;
            if (node.kind === 'for') item.meaning = `For each ${node.variable} in ${expression(node.items)}, execute this body in order.`;
            if (node.kind === 'if') item.meaning = `Branch on structural comparison ${expression(node.left)} ${node.operator} ${expression(node.right)}.`;
            if (node.kind === 'interpret') {
                item.meaning = `Agent may interpret: ${node.question}`;
                item.boundaries = { capabilities: node.capabilities, interpretationBudget: node.budget,
                    rubric: node.rubric, confidenceThreshold: node.confidence,
                    unknown: node.onUnknown, reject: node.onReject, evidence: node.evidence };
            }
            if (node.kind === 'provide') item.meaning = `Provide ${node.name} from ${expression(node.value)}.`;
            obligations.push(item);
            if (node.body) walk(node.body, depth + 1, branches);
            if (node.then) walk(node.then, depth + 1, [...branches, `IF L${location.line} THEN`]);
            if (node.else) walk(node.else, depth + 1, [...branches, `IF L${location.line} ELSE`]);
        }
    }
    walk(artifact.program.body);
    return {
        format: 'sudoc-plan', version: 1, sourceHash: artifact.sourceHash, contractHash: artifact.contractHash,
        inputs: artifact.program.inputs, outputs: artifact.program.outputs, failure: artifact.program.failure,
        guarantee: 'Checked correspondence of source contracts to supported IR operations; trusted parser, verifier, runtime, catalog and adapters are assumptions. Prose intent and model truth are not proven.',
        obligations,
    };
}

async function main(argumentsList) {
    const [command, filename, ...options] = argumentsList;
    if (!filename) return usage();
    if (command === 'lint' || command === 'format') {
        const allowed = options.length === 0 || (options.length === 1 && options[0] === (command === 'lint' ? '--json' : '--write'));
        if (!allowed || (filename === '-' && options.includes('--write'))) return usage();
        let source;
        try { source = read(filename); } catch (error) { console.error(`Cannot read ${filename}: ${error.message}`); return 2; }
        const language = authoring(source);
        const result = language.analyze(source);
        if (command === 'lint') {
            const errors = result.diagnostics.filter(item => item.severity === 'error').length;
            if (options.includes('--json')) json({ diagnostics: result.diagnostics });
            else {
                for (const diagnostic of result.diagnostics) console.log(`${filename}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity} [${diagnostic.code}] ${diagnostic.message}`);
                console.log(`${errors} error(s), ${result.diagnostics.length - errors} warning(s). ${/^\s*VERSION\b/im.test(source) ? 'Sudoc contracts checked; no execution occurred.' : 'Structure checked; prose is not evaluated.'}`);
            }
            return errors ? 1 : 0;
        }
        let formatted;
        try { formatted = language.format(source); } catch (error) { console.error(error.message); return 1; }
        if (options.includes('--write')) {
            try { fs.writeFileSync(filename, formatted); } catch (error) { console.error(`Cannot write ${filename}: ${error.message}`); return 2; }
            console.error(`Formatted ${filename}`);
        } else process.stdout.write(formatted);
        return 0;
    }
    if (!['compile', 'inspect', 'verify', 'run'].includes(command) || filename === '-') return usage();
    let artifactPath;
    let fixturePath;
    let outputPath;
    let live = false;
    let model;
    if (command === 'compile') {
        if (options.length && !(options.length === 2 && options[0] === '--out' && options[1] && !options[1].startsWith('--'))) return usage();
        outputPath = options[1];
    } else if (command === 'inspect') {
        if (options.length && !(options.length === 1 && options[0] === '--json')) return usage();
    } else if (command === 'verify') {
        if (options.length !== 1) return usage();
        artifactPath = options[0];
    } else {
        artifactPath = options.shift();
        if (!artifactPath || artifactPath.startsWith('--')) return usage();
        const seen = new Set();
        while (options.length) {
            const option = options.shift();
            if (seen.has(option)) return usage();
            seen.add(option);
            if (option === '--live-jev') live = true;
            else if ((option === '--fixture' || option === '--model') && options[0] && !options[0].startsWith('--')) {
                if (option === '--fixture') fixturePath = options.shift();
                else model = options.shift();
            } else return usage();
        }
        if (!fixturePath || (model && !live)) return usage();
    }
    let source, artifact, fixture;
    try {
        source = read(filename);
        if (artifactPath) artifact = JSON.parse(read(artifactPath));
        if (fixturePath) fixture = JSON.parse(read(fixturePath));
    } catch (error) { console.error(error instanceof SyntaxError ? 'Cannot read input: artifact or fixture contains invalid JSON.' : `Cannot read input: ${error.message}`); return 2; }
    const { compile, verify } = require('./sudoc-compiler');
    try {
        if (command === 'compile' || command === 'inspect') {
            artifact = compile(source);
            if (command === 'compile') {
                if (outputPath) {
                    const path = require('node:path');
                    if (path.resolve(outputPath) === path.resolve(filename)) throw new Error('Artifact output must not replace the source.');
                    // Refuse replacement, including aliases and symlinks to the source.
                    fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx' });
                    console.error(`Compiled ${outputPath}`);
                } else json(artifact);
            } else {
                const plan = describe(artifact, source);
                if (options.includes('--json')) json(plan);
                else {
                    console.log(`Sudoc execution contract\nSource: ${plan.sourceHash}\nContract: ${plan.contractHash}\n${plan.guarantee}\n`);
                    for (const item of plan.obligations) {
                        console.log(`${'  '.repeat(item.depth)}L${item.line} ${item.source}\n${'  '.repeat(item.depth)}  ${item.meaning}`);
                        if (item.branches.length) console.log(`${'  '.repeat(item.depth)}  Branch: ${item.branches.join(' / ')}`);
                        if (item.bindings) console.log(`${'  '.repeat(item.depth)}  Bindings: ${JSON.stringify(item.bindings)}`);
                        if (item.boundaries) console.log(`${'  '.repeat(item.depth)}  ${JSON.stringify(item.boundaries)}`);
                    }
                }
            }
            return 0;
        }
        const verification = verify(source, artifact);
        if (command === 'verify' || !verification.valid) {
            json(verification);
            return verification.valid ? 0 : 1;
        }
        const { run } = require('./sudoc-runtime');
        const runOptions = { fixture, inputs: fixture.inputs };
        if (live) {
            const { createJevJudge } = require('./sudoc-jev');
            runOptions.judge = createJevJudge(model ? { model } : {});
            runOptions.adapterTimeoutMs = 15000;
            console.error('Live JEV enabled: interpretation evidence and proposals will be sent to TypeSafe. Property changes remain in memory.');
        }
        const result = await run(source, artifact, runOptions);
        json(result);
        return result.status === 'success' ? 0 : 1;
    } catch (error) {
        if (error.diagnostics) json({ diagnostics: error.diagnostics });
        else console.error(error.message);
        return 1;
    }
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => { console.error('Sudoc could not complete the command.'); process.exitCode = 1; });
module.exports = { main, describe };
