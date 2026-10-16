const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createJevJudge, DEFAULT_MODEL, ENDPOINT } = require('./sudoc-jev');

const request = { question: 'Are the labels equivalent?', rubric: 'Preserve the business meaning.', evidence: { original: 'North', target: 'Northern' }, proposal: { equivalent: true } };
const reply = () => ({ model: DEFAULT_MODEL, answers: { acceptance: { type: 'choice', choice: 'accept', confidence: 0.96, probabilities: { accept: 0.98, reject: 0.01, unknown: 0.01 } } } });

test('JEV is opt-in, pins the model, and keeps evidence separate from acceptance instructions', async () => {
    let calls = 0;
    const judge = createJevJudge({ apiKey: 'test-secret', fetch: async (url, options) => {
        calls++;
        assert.equal(url, ENDPOINT);
        assert.equal(options.redirect, 'error');
        const body = JSON.parse(options.body);
        assert.equal(body.model, DEFAULT_MODEL);
        assert.deepEqual(body.state, { evidence: request.evidence, proposal: request.proposal });
        assert.equal(body.questions.acceptance.instructions.acceptance, request.rubric);
        return { ok: true, json: async () => reply() };
    } });
    assert.equal(calls, 0);
    const result = await judge(request);
    assert.equal(result.outcome, 'accept');
    assert.equal(result.model, DEFAULT_MODEL);
    assert.equal(calls, 1);
    assert.throws(() => createJevJudge({ apiKey: '' }), /TYPESAFE_API_KEY/);
    assert.throws(() => createJevJudge({ apiKey: 'x', model: 'jev-latest' }), /pinned/);
});

test('malformed, nonwinning, and different-model decisions cannot be accepted', async () => {
    for (const mutate of [
        data => { data.answers.acceptance.probabilities.accept = 0.3; },
        data => { data.answers.acceptance.choice = 'reject'; },
        data => { data.model = 'jev-1.99.0'; },
        data => { data.answers.acceptance.confidence = 2; },
        data => { data.answers.extra = data.answers.acceptance; },
    ]) {
        const data = reply(); mutate(data);
        const judge = createJevJudge({ apiKey: 'x', fetch: async () => ({ ok: true, json: async () => data }) });
        await assert.rejects(judge(request), /invalid or mismatched/);
    }
});

test('timeout and transport errors expose no provider content or credential', async () => {
    const timeout = createJevJudge({ apiKey: 'secret', timeoutMs: 5, fetch: () => new Promise(() => {}) });
    await assert.rejects(timeout(request), /timed out/);
    const failing = createJevJudge({ apiKey: 'secret', fetch: async () => { throw new Error('secret confidential evidence'); } });
    await assert.rejects(failing(request), error => error.message === 'JEV request failed.');
    const denied = createJevJudge({ apiKey: 'secret', fetch: async () => ({ ok: false, json: async () => { throw new Error('secret'); } }) });
    await assert.rejects(denied(request), /unsuccessful status/);
});

test('cancellation and oversized evidence make no provider request', async () => {
    let calls = 0;
    const judge = createJevJudge({ apiKey: 'x', fetch: async () => { calls++; throw new Error('unexpected'); } });
    const abort = new AbortController(); abort.abort();
    await assert.rejects(judge({ ...request, signal: abort.signal }), /cancelled/);
    await assert.rejects(judge({ ...request, evidence: 'x'.repeat(70000) }), /64 KiB/);
    assert.equal(calls, 0);
});
