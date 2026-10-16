const fs = require('node:fs');
const { analyze, format } = require('./language');

const USAGE = `Usage: node cli.js lint|check <file|-> [--json] [--catalog file.json]
       node cli.js format <file|-> [--write] [--catalog file.json]
       node cli.js complete|definition|hover <file|-> --line N --column N [--json] [--catalog file.json]
       node cli.js template <workflow|sms|send_sms>
       node cli.js review <file|-> [--json] [--model MODEL] [--catalog file.json]`;

function parseArguments(args) {
    const [command, filename, ...rest] = args;
    const commands = new Set(['lint', 'check', 'format', 'complete', 'definition', 'hover', 'template', 'review']);
    if (!commands.has(command) || !filename) throw new Error(USAGE);
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
        const flag = rest[index];
        if (Object.hasOwn(options, flag)) throw new Error(USAGE);
        if (flag === '--json' || flag === '--write') options[flag] = true;
        else if (['--line', '--column', '--catalog', '--model'].includes(flag) && rest[index + 1] && !rest[index + 1].startsWith('--')) options[flag] = rest[++index];
        else throw new Error(USAGE);
    }
    const positional = ['complete', 'definition', 'hover'].includes(command);
    const allowed = command === 'template' ? [] : command === 'format' ? ['--write', '--catalog']
        : positional ? ['--line', '--column', '--json', '--catalog']
            : command === 'review' ? ['--json', '--model', '--catalog'] : ['--json', '--catalog'];
    if (Object.keys(options).some(flag => !allowed.includes(flag)) || (filename === '-' && options['--write'])) throw new Error(USAGE);
    if (positional && ['--line', '--column'].some(flag => !/^[1-9]\d*$/.test(options[flag] || '') || !Number.isSafeInteger(Number(options[flag])))) throw new Error(USAGE);
    return { command, filename, options };
}

function printDiagnostics(filename, diagnostics) {
    for (const item of diagnostics) console.log(`${filename}:${item.line}:${item.column} ${item.severity} [${item.code}] ${item.message}`);
}

// All commands describe or edit source documents. No command executes a workflow.
async function main(args) {
    let parsed;
    try { parsed = parseArguments(args); }
    catch (error) { console.error(error.message); return 2; }
    const { command, filename, options } = parsed;
    if (command === 'template') {
        try { process.stdout.write(require('./language-services').template(filename)); return 0; }
        catch (error) { console.error(error.message); return 2; }
    }
    let source;
    let catalog;
    try {
        source = fs.readFileSync(filename === '-' ? 0 : filename, 'utf8');
        if (options['--catalog']) catalog = require('./catalog').resolveCatalog(JSON.parse(fs.readFileSync(options['--catalog'], 'utf8')));
    } catch (error) { console.error(`Cannot read input: ${error.message}`); return 2; }
    try {
        if (['complete', 'definition', 'hover'].includes(command)) {
            const result = require('./language-services')[command](source, Number(options['--line']), Number(options['--column']), { catalog });
            console.log(JSON.stringify(result));
            return 0;
        }
        if (command === 'review') {
            const report = await require('./semantic-review').review(source, { catalog, model: options['--model'] });
            if (options['--json']) console.log(JSON.stringify(report));
            else {
                printDiagnostics(filename, report.diagnostics || []);
                printDiagnostics(filename, report.deterministicDiagnostics || []);
                console.log(`Semantic review: ${report.status}${report.reason ? ` (${report.reason})` : ''}; ${report.completedQuestions || 0}/${report.totalQuestions || 0} questions reviewed. Model judgments are separate from contract validation.`);
            }
            if (report.status === 'invalid') return 1;
            if (report.status !== 'reviewed') return 2;
            return report.diagnostics.some(item => item.severity === 'warning' || item.severity === 'error') ? 1 : 0;
        }
        if (command === 'format') {
            let formatted;
            try { formatted = format(source, { catalog }); }
            catch (error) { console.error(error.message); return 1; }
            if (options['--write']) {
                try { fs.writeFileSync(filename, formatted); console.error(`Formatted ${filename}`); }
                catch (error) { console.error(`Cannot write ${filename}: ${error.message}`); return 2; }
            } else process.stdout.write(formatted);
            return 0;
        }
        const result = analyze(source, { strict: command === 'check', catalog });
        const errors = result.diagnostics.filter(item => item.severity === 'error').length;
        const report = { mode: result.mode || 'legacy', ready: result.ready === true, diagnostics: result.diagnostics };
        if (options['--json']) console.log(JSON.stringify(report));
        else {
            printDiagnostics(filename, report.diagnostics);
            console.log(`${errors} error(s), ${result.diagnostics.length - errors} warning(s). ${report.mode === 'contract' ? `Contract ready: ${report.ready ? 'yes' : 'no'}. External facts are not verified.` : 'Structure checked; prose is not evaluated.'}`);
        }
        return errors > 0 || (command === 'check' && !report.ready) ? 1 : 0;
    } catch (error) { console.error(`Authoring command failed: ${error.message}`); return 2; }
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
module.exports = { main, parseArguments };
