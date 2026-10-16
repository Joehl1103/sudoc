'use strict';

// This closed catalog is part of the trusted v1 runtime. No generated source or
// user-provided action names are evaluated as JavaScript.
const actions = {
    preflight: { args: ['portal', 'properties', 'objects'], output: 'Record', description: 'Validate every declared source dropdown and target object before any write; authorize only their exact property/object combinations.' },
    plan_property: { args: ['target'], output: 'Record', description: 'Snapshot the existing definition. Create from source options in source order, or retain existing definitions and append missing options in source order. Flag conflicting option labels for explicit interpretation.' },
    apply_property: { args: ['plan'], output: 'Record', description: 'Apply only an unchanged runtime plan within the preflight scope, after its preservation check and any required independent semantic acceptance.' },
    read_property: { args: ['target'], output: 'Record', description: 'Read the complete property definition after applying its plan and bind that fresh reading to its expected definition.' },
    build_report: { args: [], output: 'List', description: 'Report every declared property/object combination as created, updated, unchanged, failed, or not_attempted.' },
};

const checks = {
    portal_matches: { args: ['portal', 'expected'], description: 'Require the requested and authenticated fixture portal identities to equal the authored expected portal before preflight.' },
    preserve_existing: { args: ['plan'], description: 'Require every original option to retain its complete definition, including value, label, and relative order, in the expected result.' },
    matches_expected: { args: ['actual', 'expected'], description: 'Compare a fresh read-back with its registered complete expected definition; record completion only on exact equality.' },
};

module.exports = {
    actions,
    checks,
    capabilities: ['read_definitions'],
    decisions: { label_mapping: { output: 'Record' } },
};
