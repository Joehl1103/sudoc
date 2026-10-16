'use strict';

const { isDeepStrictEqual } = require('node:util');

class RunStop extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const clone = value => structuredClone(value);
const own = (object, name) => object != null && Object.hasOwn(object, name);
const keyOf = target => `${target.object}/${target.property}`;
const fail = (code, message) => { throw new RunStop('failure', code, message); };
const review = (code, message) => { throw new RunStop('review', code, message); };
function freeze(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}
function typeMatches(value, type) {
    return type === 'Number' ? typeof value === 'number' && Number.isFinite(value)
        : type === 'Text' ? typeof value === 'string'
        : type === 'Boolean' ? typeof value === 'boolean'
        : type === 'List' ? Array.isArray(value)
        : type === 'Record' ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : false;
}
function dropdown(value, description) {
    if (!value || value.type !== 'enumeration' || value.fieldType !== 'select'
        || typeof value.label !== 'string' || !Array.isArray(value.options)) {
        fail('invalid-dropdown', `${description} must be a dropdown with a label and options.`);
    }
    const values = new Set();
    for (const option of value.options) {
        if (!option || typeof option.value !== 'string' || typeof option.label !== 'string' || values.has(option.value)) {
            fail('invalid-options', `${description} has invalid or duplicate option values.`);
        }
        values.add(option.value);
    }
}
function names(value, description) {
    if (!Array.isArray(value) || value.length === 0 || value.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name))
        || new Set(value).size !== value.length) {
        fail('invalid-scope', `${description} must be a nonempty list of unique identifiers.`);
    }
}

// Adapters are trusted in-process JavaScript. Only this broker exposes workflow
// data to an agent; it is not an OS sandbox for arbitrary third-party code.
async function run(source, artifact, options = {}) {
    const trace = [];
    const outputs = {};
    let state = {};
    const rows = new Map();
    let activeTarget;
    let step = 0;
    let currentSource;
    const maxSteps = options.maxSteps ?? 10000;
    const adapterTimeoutMs = options.adapterTimeoutMs ?? 5000;
    const agentAdapter = options.agent;
    const judgeAdapter = options.judge;
    function event(kind, details = {}) {
        trace.push({ sequence: trace.length + 1, kind, ...(currentSource ? { source: clone(currentSource) } : {}), ...clone(details) });
    }
    function tick() {
        if (++step > maxSteps) fail('step-budget', `Execution exceeded its ${maxSteps}-step budget.`);
    }
    function report() { return clone([...rows.values()]); }
    const context = {
        authorizedPortal: null,
        ready: false,
        allowed: new Set(),
        plans: new Map(),
        preserved: new Set(),
        accepted: new Set(),
        applied: new Set(),
        verified: new Set(),
        readings: new Map(),
    };
    function row(target) { return rows.get(keyOf(target)); }
    function seed(properties, objects) {
        names(properties, 'Source properties');
        names(objects, 'Target objects');
        for (const property of properties) for (const object of objects) {
            const target = { object, property: `rep_${property}`, sourceProperty: property };
            if (!rows.has(keyOf(target))) rows.set(keyOf(target), { ...target, status: 'not_attempted' });
        }
    }
    function targetAllowed(target) {
        if (!target || !context.ready || !context.allowed.has(keyOf(target))) {
            fail('unauthorized-target', 'The operation targets a property outside the validated preflight scope.');
        }
        const original = row(target);
        if (original.sourceProperty !== target.sourceProperty) fail('unauthorized-target', 'Target source property was changed.');
        activeTarget = target;
        return original;
    }
    function knownPlan(plan) {
        const original = plan && context.plans.get(plan.id);
        if (!original || !isDeepStrictEqual(original, plan)) fail('invalid-plan', 'Only an unchanged runtime-generated property plan may be used.');
        targetAllowed(plan.target);
        return original;
    }
    function evaluate(expression, env) {
        if (expression.kind === 'literal') return clone(expression.value);
        if (expression.kind !== 'ref' || !own(env, expression.name)) fail('missing-value', `Value ${expression.name} is unavailable.`);
        let value = env[expression.name];
        for (const part of expression.path) {
            if (!own(value, part) || ['__proto__', 'prototype', 'constructor'].includes(part)) fail('missing-field', `Field ${expression.name}.${expression.path.join('.')} is unavailable.`);
            value = value[part];
        }
        return value;
    }
    function argsOf(args, env) { return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, evaluate(value, env)])); }

    const actions = {
        preflight({ portal, properties, objects }) {
            if (context.ready) fail('duplicate-preflight', 'A run may declare its write scope only once.');
            seed(properties, objects);
            if (context.authorizedPortal !== portal || state.portal !== portal) fail('portal-not-checked', 'Check the authenticated fixture portal before preflight.');
            for (const property of properties) {
                if (!own(state.sourceProperties, property)) fail('missing-source', `Missing source property ${property}.`);
                dropdown(state.sourceProperties[property], `Source ${property}`);
                if (state.sourceProperties[property].name !== property) fail('invalid-source', `Source property ${property} has a different name.`);
            }
            for (const object of objects) {
                if (!own(state.objects, object) || !typeMatches(state.objects[object], 'Record')) fail('missing-object', `Missing target object ${object}.`);
            }
            const targets = properties.flatMap(property => objects.map(object => ({ object, property: `rep_${property}`, sourceProperty: property })));
            context.allowed = new Set(targets.map(keyOf));
            context.ready = true;
            return { targets };
        },
        plan_property({ target }) {
            targetAllowed(target);
            if ([...context.plans.values()].some(plan => keyOf(plan.target) === keyOf(target))) fail('duplicate-target', 'A target may be planned only once per run.');
            const sourceProperty = state.sourceProperties[target.sourceProperty];
            const existing = own(state.objects[target.object], target.property) ? clone(state.objects[target.object][target.property]) : null;
            if (existing) dropdown(existing, `Target ${keyOf(target)}`);
            const expected = existing ? clone(existing) : {
                name: target.property, label: `Rep ${sourceProperty.label}`, type: 'enumeration', fieldType: 'select', options: clone(sourceProperty.options),
            };
            if (existing && existing.name !== target.property) fail('invalid-target', `Target ${keyOf(target)} has a different name.`);
            const conflicts = [];
            if (existing) for (const option of sourceProperty.options) {
                const old = existing.options.find(item => item.value === option.value);
                if (!old) expected.options.push(clone(option));
                else if (old.label !== option.label) conflicts.push({ value: option.value, sourceLabel: option.label, existingLabel: old.label });
            }
            const plan = {
                id: `plan:${keyOf(target)}`, target: clone(target), source: clone(sourceProperty), existing, expected,
                conflicts, hasConflicts: conflicts.length > 0,
                operation: !existing ? 'created' : isDeepStrictEqual(existing, expected) ? 'unchanged' : 'updated',
            };
            context.plans.set(plan.id, clone(plan));
            return plan;
        },
        apply_property({ plan }) {
            knownPlan(plan);
            if ([...context.applied].some(id => !context.verified.has(id))) fail('verification-required', 'Verify the preceding property before applying another plan.');
            if (!context.preserved.has(plan.id)) fail('preservation-required', 'The authored preservation check must pass before a property is applied.');
            if (plan.hasConflicts && !context.accepted.has(plan.id)) fail('interpretation-required', 'Conflicting labels require an explicitly authorized interpretation and independent acceptance.');
            if (context.applied.has(plan.id)) fail('duplicate-apply', 'A property plan may be applied only once.');
            const current = own(state.objects[plan.target.object], plan.target.property) ? state.objects[plan.target.object][plan.target.property] : null;
            if (!isDeepStrictEqual(current, plan.existing)) fail('stale-plan', 'The target changed after planning.');
            const key = keyOf(plan.target);
            if (state.faults?.writeFailure === key) fail('write-failed', `Simulated write failure for ${key}.`);
            if (plan.operation !== 'unchanged') {
                state.objects[plan.target.object][plan.target.property] = clone(plan.expected);
                event('write', { target: plan.target, operation: plan.operation, expected: plan.expected, simulation: true });
            }
            context.applied.add(plan.id);
            return { target: plan.target, operation: plan.operation };
        },
        read_property({ target }) {
            targetAllowed(target);
            const plan = [...context.plans.values()].find(item => keyOf(item.target) === keyOf(target));
            if (!plan || !context.applied.has(plan.id)) fail('readback-order', 'Read-back must follow applying its property plan.');
            const actual = clone(state.objects[target.object][target.property]);
            if (state.faults?.readbackMismatch === keyOf(target)) actual.options = [];
            // Identity binds the check to this fresh read, not a fabricated literal.
            context.readings.set(actual, plan.id);
            event('read-back', { target, actual, simulation: true });
            return actual;
        },
        build_report() { return report(); },
    };
    const checks = {
        portal_matches({ portal, expected }) {
            if (portal !== expected || state.portal !== expected) fail('portal-mismatch', 'The requested and authenticated fixture portals must equal the authored portal.');
            context.authorizedPortal = portal;
        },
        preserve_existing({ plan }) {
            knownPlan(plan);
            if (plan.existing) {
                const original = plan.existing.options;
                const prefix = plan.expected.options.slice(0, original.length);
                if (!isDeepStrictEqual(prefix, original)) fail('preservation-failed', 'Existing option values, labels, and relative order changed.');
            }
            context.preserved.add(plan.id);
        },
        matches_expected({ actual, expected }) {
            const id = context.readings.get(actual);
            const plan = id && context.plans.get(id);
            if (!plan || !isDeepStrictEqual(expected, plan.expected)) fail('unbound-readback', 'Verification must compare a fresh runtime read against its registered expected definition.');
            activeTarget = plan.target;
            if (!isDeepStrictEqual(actual, expected)) fail('readback-mismatch', `Read-back differs from the expected definition for ${keyOf(plan.target)}.`);
            context.verified.add(plan.id);
            row(plan.target).status = plan.operation;
        },
    };

    async function interpret(node, env) {
        const evidence = argsOf(node.evidence, env);
        if (node.decision !== 'label_mapping' || !evidence.property) fail('invalid-interpretation', 'label_mapping requires evidence named property.');
        const plan = knownPlan(evidence.property);
        if (!plan.hasConflicts) fail('no-conflict', 'label_mapping requires a conflicting property definition.');
        let live = true;
        let used = 1; // The proposal request itself consumes one unit.
        let brokerFailure;
        const controller = new AbortController();
        const tools = Object.create(null);
        if (node.capabilities.includes('read_definitions')) tools.read_definitions = async () => {
            if (!live) throw new RunStop('review', 'expired-capability', 'The interpretation capability has expired.');
            try { tick(); } catch (error) { brokerFailure = error; throw error; }
            if (++used > node.budget) {
                brokerFailure = new RunStop('review', 'interpretation-budget', 'The interpretation exceeded its declared budget.');
                throw brokerFailure;
            }
            event('capability', { name: 'read_definitions', budgetUsed: used, budget: node.budget, target: plan.target });
            return freeze(clone({ source: plan.source, existing: plan.existing, proposed: plan.expected, conflicts: plan.conflicts }));
        };
        const agent = agentAdapter || (async request => {
            if (request.tools.read_definitions && node.budget > 1) await request.tools.read_definitions();
            const proposal = state.proposals?.[keyOf(plan.target)];
            if (!proposal) review('missing-proposal', 'The simulation has no agent proposal for this interpretation.');
            return clone(proposal);
        });
        async function bounded(operation, adapterName) {
            let timer;
            try {
                return await Promise.race([
                    Promise.resolve().then(operation),
                    new Promise((_, reject) => { timer = setTimeout(() => reject(new RunStop('review', 'adapter-timeout', 'The interpretation adapter timed out.')), adapterTimeoutMs); }),
                ]);
            } catch (error) {
                if (error instanceof RunStop) throw error;
                review('adapter-failed', `The ${adapterName} adapter failed; its result requires review.`);
            } finally { clearTimeout(timer); }
        }
        let proposal;
        try {
            proposal = await bounded(async () => clone(await agent(Object.freeze({
                decision: node.decision, question: node.question, evidence: freeze(clone(evidence)), capabilities: Object.freeze([...node.capabilities]), budget: node.budget,
                tools: Object.freeze(tools), signal: controller.signal,
            }))), 'agent');
            if (brokerFailure) throw brokerFailure;
        } finally {
            live = false;
            controller.abort();
        }
        // An agent may propose only semantic equivalence, never replacement data,
        // new capabilities, an evaluator, or acceptance criteria.
        const proposalKeys = proposal && Object.keys(proposal).sort();
        if (!proposal || !isDeepStrictEqual(proposalKeys, ['equivalent', 'mappings', 'rationale'])
            || typeof proposal.equivalent !== 'boolean' || typeof proposal.rationale !== 'string' || !proposal.rationale.trim()
            || !Array.isArray(proposal.mappings) || proposal.mappings.length !== plan.conflicts.length) {
            review('invalid-proposal', 'The agent returned an invalid semantic-equivalence proposal.');
        }
        const mapped = new Set();
        for (const mapping of proposal.mappings) {
            const conflict = plan.conflicts.find(item => item.value === mapping?.value);
            if (!conflict || mapped.has(mapping.value) || typeof mapping.equivalent !== 'boolean'
                || !isDeepStrictEqual(Object.keys(mapping).sort(), ['equivalent', 'existingLabel', 'sourceLabel', 'value'])
                || mapping.sourceLabel !== conflict.sourceLabel || mapping.existingLabel !== conflict.existingLabel) {
                review('invalid-proposal', 'The proposal must cover each original conflict exactly once without changing its evidence.');
            }
            mapped.add(mapping.value);
        }
        if (proposal.equivalent !== proposal.mappings.every(item => item.equivalent)) review('invalid-proposal', 'The proposal contradicts its individual mappings.');
        event('proposal', { decision: node.decision, proposal, evidence, budgetUsed: used, simulation: !agentAdapter });
        const judge = judgeAdapter || (async () => clone(state.judgments?.[keyOf(plan.target)] || { outcome: 'unknown', confidence: 0 }));
        const judgeController = new AbortController();
        let judgment;
        try {
            judgment = await bounded(async () => clone(await judge({
                question: node.question, rubric: node.rubric, evidence: freeze(clone(evidence)), proposal: freeze(clone(proposal)), signal: judgeController.signal,
            })), 'judge');
        } finally { judgeController.abort(); }
        if (!judgment || !['accept', 'reject', 'unknown'].includes(judgment.outcome)
            || !Number.isFinite(judgment.confidence) || judgment.confidence < 0 || judgment.confidence > 1) {
            review('invalid-judgment', 'The independent evaluator returned a malformed outcome or confidence.');
        }
        if (judgment.probabilities !== undefined) {
            const probabilities = judgment.probabilities;
            if (!probabilities || !isDeepStrictEqual(Object.keys(probabilities).sort(), ['accept', 'reject', 'unknown'])
                || Object.values(probabilities).some(value => !Number.isFinite(value) || value < 0 || value > 1)
                || Math.abs(Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1) > 1e-6
                || probabilities[judgment.outcome] !== Math.max(...Object.values(probabilities))) {
                review('invalid-judgment', 'The evaluator returned an inconsistent probability distribution.');
            }
        }
        event('judgment', { judgment, threshold: node.confidence, rubric: node.rubric, simulation: !judgeAdapter });
        if (judgment.outcome === 'unknown' || judgment.confidence < node.confidence) review('uncertain-judgment', 'The independent evaluator did not reach the authored confidence threshold.');
        if (judgment.outcome === 'reject' || !proposal.equivalent) fail('interpretation-rejected', 'The semantic-equivalence proposal was rejected.');
        context.accepted.add(plan.id);
        return clone(proposal);
    }

    async function execute(nodes, env) {
        for (const node of nodes) {
            currentSource = node.source;
            tick();
            if (node.kind === 'run') {
                const result = actions[node.action](argsOf(node.args, env));
                if (node.out) env[node.out] = freeze(result);
                event('action', { action: node.action, status: 'passed' });
            } else if (node.kind === 'check') {
                checks[node.check](argsOf(node.args, env));
                event('check', { check: node.check, status: 'passed' });
            } else if (node.kind === 'for') {
                const items = evaluate(node.items, env);
                if (!Array.isArray(items)) fail('invalid-loop', 'FOR EACH requires a list.');
                for (const item of items) await execute(node.body, Object.assign(Object.create(null), env, { [node.variable]: item }));
            } else if (node.kind === 'if') {
                const equals = isDeepStrictEqual(evaluate(node.left, env), evaluate(node.right, env));
                const result = node.operator === '==' ? equals : !equals;
                event('condition', { result });
                await execute(result ? node.then : node.else, Object.assign(Object.create(null), env));
            } else if (node.kind === 'interpret') {
                env[node.out] = freeze(await interpret(node, env));
            } else if (node.kind === 'provide') {
                outputs[node.name] = clone(evaluate(node.value, env));
                event('output', { name: node.name });
            } else fail('unknown-node', `Unsupported executable node ${node.kind}.`);
        }
    }

    try {
        const { verify, canonical } = require('./sudoc-compiler');
        // Execute the exact immutable snapshot that was verified. An adapter's
        // closure may retain the caller's original artifact, never this copy.
        artifact = freeze(clone(artifact));
        const verification = verify(source, artifact);
        if (!verification.valid) fail('artifact-invalid', `Artifact verification failed: ${(verification.diagnostics || []).map(item => item.message).join(' ')}`);
        event('artifact-verified', { sourceHash: artifact.sourceHash, contractHash: artifact.contractHash });
        if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || !Number.isSafeInteger(adapterTimeoutMs) || adapterTimeoutMs < 1) fail('invalid-budget', 'Runtime budgets must be positive integers.');
        function validateJson(value, label) {
            function containsNegativeZero(item) {
                return Object.is(item, -0) || (item !== null && typeof item === 'object' && Object.values(item).some(containsNegativeZero));
            }
            try {
                canonical(value);
                if (containsNegativeZero(value)) throw new TypeError('Negative zero is not preserved in JSON traces.');
            } catch {
                fail('invalid-data', `${label} must contain finite, acyclic plain JSON data without negative zero.`);
            }
        }
        const fixture = options.fixture ?? {};
        validateJson(fixture, 'Fixture');
        const inputs = options.inputs ?? fixture.inputs ?? {};
        validateJson(inputs, 'Inputs');
        state = clone(fixture);
        const env = Object.create(null);
        for (const input of artifact.program.inputs) {
            if (!own(inputs, input.name) || !typeMatches(inputs[input.name], input.type)) fail('invalid-input', `Input ${input.name} must be ${input.type}.`);
            env[input.name] = freeze(clone(inputs[input.name]));
        }
        // Seed the declared top-level manifest for complete partial reports, even
        // if the portal guard or source preflight fails before any write.
        const manifest = artifact.program.body.find(node => node.kind === 'run' && node.action === 'preflight');
        if (manifest) {
            try {
                const args = argsOf(manifest.args, env);
                seed(args.properties, args.objects);
            } catch (error) {
                // Dynamically computed arguments are resolved at their normal
                // source position; they grant no capability during inspection.
                if (error.code !== 'missing-value' && error.code !== 'missing-field') throw error;
            }
        }
        await execute(artifact.program.body, env);
        for (const plan of context.plans.values()) if (!context.verified.has(plan.id)) fail('unverified-result', 'Every planned property requires a fresh read-back check before success.');
        if ([...rows.values()].some(item => item.status === 'not_attempted')) fail('incomplete-run', 'The declared target manifest is incomplete.');
        for (const output of artifact.program.outputs) if (!own(outputs, output.name) || !typeMatches(outputs[output.name], output.type)) fail('missing-output', `Output ${output.name} must be provided as ${output.type}.`);
        event('completed', { status: 'success', steps: step });
        return { status: 'success', outputs, trace, report: report(), state };
    } catch (error) {
        const status = error instanceof RunStop ? error.status : 'failure';
        const detail = { code: error.code || 'runtime-error', message: error.message || String(error) };
        if (activeTarget && row(activeTarget) && row(activeTarget).status === 'not_attempted') {
            row(activeTarget).status = 'failed';
            row(activeTarget).error = detail;
        }
        event('stopped', { status, error: detail, steps: step });
        return { status, outputs, trace, report: report(), state, error: detail };
    }
}

module.exports = { run };
