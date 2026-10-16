// Authoring contracts only. Nothing in this catalog invokes an external service.
const DEFAULT_CATALOG = {
    types: {
        Text: { description: 'A text value.' },
        PhoneNumber: { base: 'Text', description: 'A phone number supplied by a trusted source; no delivery guarantee.' },
        Number: { description: 'A finite numeric value.' },
        Boolean: { description: 'A Boolean observation; unavailable observations may be unknown.' },
        Decision: { description: 'One of true, false, or unknown.' },
        Evidence: { description: 'Evidence supplied for a human or model review.' },
        SmsReceipt: { fields: { id: 'Text', to: 'PhoneNumber', status: 'Text' }, description: 'A successful SMS provider receipt.' },
        Customer: { fields: { phone: 'PhoneNumber', name: 'Text', smsEnabled: 'Boolean' }, description: 'Customer contact and consent information.' },
    },
    actions: {
        send_sms: {
            description: 'Send a text message through an SMS provider with confirmed consent.',
            arguments: {
                to: { type: 'PhoneNumber', required: true, description: 'The recipient phone number.' },
                body: { type: 'Text', required: true, description: 'The exact message text.' },
            },
            output: 'SmsReceipt',
            outcomes: ['success', 'failure', 'unknown'],
        },
    },
};

function resolveCatalog(catalog) {
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const fail = message => { throw new TypeError(`Invalid domain catalog: ${message}`); };
    if (catalog !== undefined && !object(catalog)) fail('expected an object.');
    if (catalog?.types !== undefined && !object(catalog.types)) fail('types must be an object.');
    if (catalog?.actions !== undefined && !object(catalog.actions)) fail('actions must be an object.');
    const result = { types: { ...DEFAULT_CATALOG.types, ...catalog?.types }, actions: { ...DEFAULT_CATALOG.actions, ...catalog?.actions } };
    const knownType = type => typeof type === 'string' && Object.hasOwn(result.types, type);
    for (const [name, spec] of Object.entries(result.types)) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || !object(spec)) fail(`invalid type ${name}.`);
        if (['Invalid', 'Unknown'].includes(name)) fail(`${name} is a reserved analysis type.`);
        if (['Text', 'Number', 'Boolean', 'Decision'].includes(name) && (spec.base !== undefined || spec.fields !== undefined)) fail(`${name} is an intrinsic scalar type and cannot declare a base or fields.`);
        if (spec.base !== undefined && !knownType(spec.base)) fail(`${name} has unknown base type ${spec.base}.`);
        if (spec.fields !== undefined && !object(spec.fields)) fail(`${name}.fields must be an object.`);
        for (const [field, type] of Object.entries(spec.fields || {})) {
            if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field) || !knownType(type)) fail(`${name}.${field} must reference a known type.`);
        }
        const visited = new Set([name]);
        let base = spec.base;
        while (base) {
            if (visited.has(base)) fail(`cyclic base type for ${name}.`);
            visited.add(base); base = result.types[base]?.base;
        }
    }
    for (const [name, spec] of Object.entries(result.actions)) {
        if (!/^[a-z][a-z0-9_]*$/.test(name) || !object(spec)) fail(`invalid action ${name}.`);
        if (!object(spec.arguments)) fail(`${name}.arguments must be an object.`);
        for (const [argument, binding] of Object.entries(spec.arguments)) {
            if (!/^[a-z][a-z0-9_]*$/.test(argument) || !object(binding) || !knownType(binding.type)) fail(`${name}.${argument} must declare a known type.`);
            if (binding.required !== undefined && typeof binding.required !== 'boolean') fail(`${name}.${argument}.required must be Boolean.`);
        }
        if (!knownType(spec.output)) fail(`${name}.output must declare a known type.`);
        if (!Array.isArray(spec.outcomes) || spec.outcomes.length !== 3 || !['success', 'failure', 'unknown'].every(outcome => spec.outcomes.includes(outcome))) fail(`${name}.outcomes must contain success, failure, and unknown exactly once.`);
    }
    return result;
}

function isAssignable(actual, expected, catalog = DEFAULT_CATALOG) {
    if (actual === 'Unknown' || actual === 'Invalid') return actual === 'Invalid';
    const visited = new Set();
    while (actual && !visited.has(actual)) {
        if (actual === expected || (actual === 'Boolean' && expected === 'Decision')) return true;
        visited.add(actual);
        actual = catalog.types[actual]?.base;
    }
    return false;
}

module.exports = { DEFAULT_CATALOG, resolveCatalog, isAssignable };
