const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Pass the plugin path through the child environment so spaces need no Ex escaping.
function editorArguments(projectDirectory) {
    return [
        '-c',
        'lua dofile(vim.env.WORKFLOW_EXPERIMENT_PLUGIN)',
        path.join(projectDirectory, 'examples/dropdown-sync.sudoc'),
    ];
}

// Keep the project path explicit so the same shortcut works from npm or Node.
function openEditor() {
    const environment = { ...process.env };
    environment.WORKFLOW_EXPERIMENT_PLUGIN = path.join(__dirname, 'nvim/workflow.lua');
    const result = spawnSync('nvim', editorArguments(__dirname), {
        stdio: 'inherit',
        env: environment,
    });
    if (result.error) {
        console.error(`Could not launch Neovim: ${result.error.message}`);
        return 1;
    }
    if (result.status === null) {
        return 1;
    }
    return result.status;
}

if (require.main === module) {
    process.exitCode = openEditor();
}

module.exports = { editorArguments };
