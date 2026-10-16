const test = require('node:test');
const assert = require('node:assert/strict');
const { review, buildReviewCandidates, documentHash, DEFAULT_MODEL } = require('./semantic-review');

// Synthetic authoring data only. These tests never use the network or a real key.
const SOURCE = `@WORKFLOW:
    CONTRACT 1
    INPUT $RECIPIENT AS PhoneNumber FROM "customer.phone"
    INPUT $MESSAGE AS Text FROM "request.message"
    INPUT $ENABLED AS Boolean FROM "consent.sms"
    INPUT $UNRELATED AS Text FROM "private.unrelated"
    OUTPUT $RECEIPT AS SmsReceipt
    NOTE Unrelated private note must not be in review evidence.
    CONDITION $READY AS $ENABLED == true
    DECIDE $READY:
        WHEN true:
            DO send_sms:
                NOTE Send the customer's requested text.
                WITH to = $RECIPIENT
                WITH body = $MESSAGE
                PRODUCES $RECEIPT
                ON success:
                    NOTE Retain the provider receipt.
                    EXIT SUCCESS
                ON failure:
                    EXIT FAILURE
                ON unknown:
                    EXIT REVIEW
        WHEN false:
            NOTE SMS consent is disabled.
            EXIT FAILURE
        WHEN unknown:
            EXIT REVIEW
`;

function responseFor(body, outcomes = ['supported']) {
    const request = typeof body === 'string' ? JSON.parse(body) : body;
    return {
        model: 'jev-1.13.0',
        answers: Object.fromEntries(Object.keys(request.questions).map((id, index) => {
            const choice = outcomes[index % outcomes.length];
            return [id, {
                type: 'choice', choice, confidence: 0.9,
                probabilities: Object.fromEntries(['supported', 'contradicted', 'insufficient_evidence'].map(option => [option, option === choice ? 0.9 : 0.05])),
            }];
        })),
        usage: { input_tokens: 100, output_tokens: 20 },
    };
}

const unexpectedFetch = async () => { throw new Error('This case must remain offline.'); };

test('candidates use parsed contracts and only directly relevant evidence', () => {
    const built = buildReviewCandidates(SOURCE);
    assert.equal(built.reason, 'not-requested');
    assert.equal(built.totalQuestions, 5);
    assert.equal(built.candidates.length, 5);
    assert.equal(built.candidates.filter(item => item.rule === 'argument-meaning').length, 2);
    const recipient = built.candidates.find(item => item.evidence.argument?.name === 'to');
    assert.deepEqual(recipient.evidence.binding.inputs, [{ name: '$RECIPIENT', type: 'PhoneNumber', sourceBinding: '"customer.phone"' }]);
    assert.equal(recipient.line, 14);
    assert.equal(recipient.column, 17);
    assert.equal(recipient.endColumn, SOURCE.split('\n')[13].length + 1);
    const success = built.candidates.find(item => item.evidence.actionOutcome === 'success');
    assert.equal(success.evidence.note, 'Retain the provider receipt.');
    const disabled = built.candidates.find(item => item.evidence.branch?.outcome === 'false');
    assert.equal(disabled.evidence.branch.condition, '$READY');
    assert.equal(disabled.evidence.branch.expression, '$ENABLED == true');
    assert.doesNotMatch(JSON.stringify(built.candidates), /private\.unrelated|Unrelated private/);
});

test('legacy documents, invalid contracts, and unfinished drafts do not call a provider', async () => {
    assert.equal((await review('@WORKFLOW:\n    DO read the document\n', { apiKey: 'test', fetch: unexpectedFetch })).reason, 'legacy-document');
    const invalid = await review(SOURCE.replace('                WITH to = $RECIPIENT\n', ''), { apiKey: 'test', fetch: unexpectedFetch });
    assert.equal(invalid.status, 'invalid');
    assert.equal(invalid.reason, 'contract-errors');
    assert.ok(invalid.deterministicDiagnostics.length);
    const draft = await review(SOURCE.replace('"customer.phone"', '?'), { apiKey: 'test', fetch: unexpectedFetch });
    assert.equal(draft.status, 'invalid');
});

test('missing credentials and a valid document without bounded review rules are explicitly unreviewed', async () => {
    const result = await review(SOURCE, { apiKey: '', fetch: unexpectedFetch });
    assert.equal(result.status, 'unreviewed');
    assert.equal(result.reason, 'missing-credentials');
    assert.equal(result.completedQuestions, 0);
    assert.deepEqual(result.diagnostics, []);
    const noCandidates = SOURCE.replace(/\s+NOTE[^\n]+/g, '').replace(/            DO send_sms:[\s\S]*?        WHEN false:/, '            EXIT FAILURE\n        WHEN false:');
    const empty = await review(noCandidates, { apiKey: 'test', fetch: unexpectedFetch });
    assert.equal(empty.status, 'unreviewed');
    assert.equal(empty.reason, 'no-reviewable-statements');
});

test('typed HTTP request maps all outcomes to app-authored model diagnostics', async () => {
    let calls = 0;
    const result = await review(SOURCE, {
        apiKey: 'synthetic-key',
        fetch: async (url, init) => {
            calls += 1;
            assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
            assert.equal(init.method, 'POST');
            assert.equal(init.headers.Authorization, 'Bearer synthetic-key');
            assert.equal(init.redirect, 'error');
            assert.ok(init.signal instanceof AbortSignal);
            const request = JSON.parse(init.body);
            assert.equal(request.model, DEFAULT_MODEL);
            for (const [id, question] of Object.entries(request.questions)) {
                assert.equal(question.type, 'choice');
                assert.deepEqual(Object.keys(question.criteria), ['supported', 'contradicted', 'insufficient_evidence']);
                assert.ok(question.instructions.includes(`state.fragments.${id}`));
                assert.ok(request.state.fragments[id]);
            }
            const body = responseFor(request, ['supported', 'contradicted', 'insufficient_evidence']);
            body.answers.q1.message = 'Provider-written prose must never become a diagnostic.';
            return { ok: true, json: async () => body };
        },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'reviewed');
    assert.equal(result.completedQuestions, 5);
    assert.equal(result.documentHash, documentHash(SOURCE));
    assert.equal(result.diagnostics[0].outcome, 'supported');
    assert.equal(result.diagnostics[0].severity, 'information');
    assert.equal(result.diagnostics[1].outcome, 'contradicted');
    assert.equal(result.diagnostics[1].severity, 'warning');
    assert.equal(result.diagnostics[2].outcome, 'insufficient_evidence');
    assert.ok(result.diagnostics.every(item => item.category === 'model' && item.code.startsWith('jev-')));
    assert.doesNotMatch(JSON.stringify(result), /Provider-written|synthetic-key/);
});

test('incomplete or malformed provider answers cannot be represented as a completed review', async t => {
    const mutations = {
        missing: body => { delete body.answers.q1; },
        extra: body => { body.answers.unrequested = body.answers.q1; },
        wrongType: body => { body.answers.q1.type = 'noul'; },
        wrongOutcome: body => { body.answers.q1.choice = 'safe'; },
        missingProbability: body => { delete body.answers.q1.probabilities.contradicted; },
        invalidProbability: body => { body.answers.q1.probabilities.supported = 1.4; },
        invalidSum: body => { body.answers.q1.probabilities.supported = 0.5; },
        notHighestProbability: body => { body.answers.q1.choice = 'contradicted'; },
        invalidConfidence: body => { body.answers.q1.confidence = NaN; },
        missingModel: body => { delete body.model; },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
        await t.test(name, async () => {
            const result = await review(SOURCE, { apiKey: 'test', fetch: async (_, init) => {
                const body = responseFor(init.body);
                mutate(body);
                return { ok: true, json: async () => body };
            } });
            assert.equal(result.status, 'unavailable');
            assert.equal(result.reason, 'invalid-response');
            assert.equal(result.completedQuestions, 0);
            assert.deepEqual(result.diagnostics, []);
        });
    }
});

test('network and HTTP failures are honest and never echo provider bodies or secrets', async () => {
    const denied = await review(SOURCE, { apiKey: 'synthetic-key', fetch: async () => ({
        ok: false, status: 401, json: async () => { throw new Error('Response body must not be read.'); },
    }) });
    assert.equal(denied.status, 'unavailable');
    assert.equal(denied.reason, 'http-error');
    assert.equal(denied.httpStatus, 401);
    const failed = await review(SOURCE, { apiKey: 'synthetic-key', fetch: async () => {
        throw { message: 'synthetic-key', reviewReason: 'synthetic-key' };
    } });
    assert.equal(failed.reason, 'network-error');
    assert.doesNotMatch(JSON.stringify(failed), /synthetic-key/);
});

test('timeouts remain bounded even for a transport that ignores abort', async () => {
    let signal;
    const result = await review(SOURCE, { apiKey: 'test', timeoutMs: 10, fetch: (_, init) => {
        signal = init.signal;
        return new Promise(() => {});
    } });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'timeout');
    assert.equal(signal.aborted, true);
});

test('cancellation before and during requests produces no publishable model diagnostics', async () => {
    const before = new AbortController();
    before.abort();
    const result = await review(SOURCE, { apiKey: 'test', signal: before.signal, fetch: unexpectedFetch });
    assert.equal(result.reason, 'cancelled');
    const during = new AbortController();
    const pending = review(SOURCE, { apiKey: 'test', signal: during.signal, fetch: () => new Promise(() => {}) });
    during.abort();
    const cancelled = await pending;
    assert.equal(cancelled.status, 'unreviewed');
    assert.equal(cancelled.reason, 'cancelled');
    assert.deepEqual(cancelled.diagnostics, []);
});

test('question and byte limits preserve whole evidence and report partial review', async () => {
    const result = await review(SOURCE, {
        apiKey: 'test', maxQuestions: 1,
        fetch: async (_, init) => ({ ok: true, json: async () => responseFor(init.body) }),
    });
    assert.equal(result.status, 'unreviewed');
    assert.equal(result.reason, 'limits-exceeded');
    assert.equal(result.completedQuestions, 1);
    assert.equal(result.totalQuestions, 5);
    assert.equal(result.omitted.length, 4);
    const oversizedNote = SOURCE.replace('Retain the provider receipt.', 'Long note '.repeat(1000));
    const built = buildReviewCandidates(oversizedNote);
    assert.equal(built.omitted.length, 1);
    assert.equal(built.omitted[0].reason, 'slice-too-large');
    assert.equal(built.candidates.length, 4);
    const noRoom = await review(SOURCE, { apiKey: 'test', maxRequestBytes: 1, fetch: unexpectedFetch });
    assert.equal(noRoom.reason, 'limits-exceeded');
    assert.equal(noRoom.completedQuestions, 0);
    assert.equal(noRoom.omitted.length, 5);
});

test('review identity distinguishes exact source, model, catalog, and rubric', () => {
    const initial = buildReviewCandidates(SOURCE);
    const changedSource = buildReviewCandidates(SOURCE + '# changed\n');
    const changedModel = buildReviewCandidates(SOURCE, { model: 'jev-1.14.0' });
    const changedCatalog = buildReviewCandidates(SOURCE, { catalog: { types: { NewType: { description: 'A new catalog fact.' } } } });
    assert.equal(initial.requestedModel, DEFAULT_MODEL);
    assert.ok(initial.rubricVersion);
    assert.notEqual(initial.documentHash, changedSource.documentHash);
    assert.notEqual(initial.reviewKey, changedSource.reviewKey);
    assert.notEqual(initial.reviewKey, changedModel.reviewKey);
    assert.notEqual(initial.catalogHash, changedCatalog.catalogHash);
    assert.notEqual(initial.reviewKey, changedCatalog.reviewKey);
    assert.equal(initial.reviewKey, buildReviewCandidates(SOURCE).reviewKey);
});

test('invalid model configuration is rejected without provider access', async () => {
    const result = await review(SOURCE, { model: '', apiKey: 'test', fetch: unexpectedFetch });
    assert.equal(result.status, 'invalid');
    assert.equal(result.reason, 'invalid-model');
});


test('literal dollar names cannot pull unrelated input metadata into evidence', () => {
    const source = SOURCE.replace('WITH body = $MESSAGE', 'WITH body = "$UNRELATED is literal message text"');
    const built = buildReviewCandidates(source);
    const message = built.candidates.find(item => item.evidence.argument?.name === 'body');
    assert.deepEqual(message.evidence.binding.inputs, []);
    assert.doesNotMatch(JSON.stringify(built.candidates), /private\.unrelated/);
});


test('model identity rejects malformed responses and enforces an explicit version pin', async t => {
    for (const model of ['', '   ', 'unrelated-provider-model', 'jev-latest', 'jev-1.14.0', 'jev-1.13.0\n']) {
        await t.test(JSON.stringify(model), async () => {
            const result = await review(SOURCE, { apiKey: 'test', fetch: async (_, init) => {
                const body = responseFor(init.body);
                body.model = model;
                return { ok: true, json: async () => body };
            } });
            assert.equal(result.status, 'unavailable');
            assert.equal(result.reason, 'invalid-response');
            assert.deepEqual(result.diagnostics, []);
        });
    }
    for (const alias of ['jev-latest', 'jev-preview']) {
        const result = await review(SOURCE, { apiKey: 'test', model: alias, fetch: async (_, init) => {
            const body = responseFor(init.body);
            body.model = 'jev-1.14.0';
            return { ok: true, json: async () => body };
        } });
        assert.equal(result.status, 'reviewed');
        assert.equal(result.requestedModel, alias);
        assert.equal(result.model, 'jev-1.14.0');
    }
});

test('invalid catalog reports invalid without exposing catalog content or making a request', async () => {
    const catalog = { types: { PrivateField: { base: 'private_catalog_detail' } } };
    const preview = buildReviewCandidates(SOURCE, { catalog });
    assert.equal(preview.status, 'invalid');
    assert.equal(preview.reason, 'invalid-catalog');
    const result = await review(SOURCE, { apiKey: 'test', catalog, fetch: unexpectedFetch });
    assert.equal(result.status, 'invalid');
    assert.equal(result.reason, 'invalid-catalog');
    assert.doesNotMatch(JSON.stringify(result), /private_catalog_detail|PrivateField/);
});

test('unreachable actions and notes are outside semantic review evidence', () => {
    const deadAction = `    DO send_sms:
        NOTE Dead private instruction must not be reviewed.
        WITH to = $RECIPIENT
        WITH body = $MESSAGE
        PRODUCES $RECEIPT
        ON success:
            EXIT SUCCESS
        ON failure:
            EXIT FAILURE
        ON unknown:
            EXIT REVIEW
`;
    const preview = buildReviewCandidates(SOURCE + deadAction);
    assert.equal(preview.reason, 'not-requested');
    assert.equal(preview.totalQuestions, 5);
    assert.doesNotMatch(JSON.stringify(preview.candidates), /Dead private/);
});
