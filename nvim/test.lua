-- Run inside real headless Neovim, using actual buffers, diagnostics, and commands.
local project_directory = vim.fn.getcwd()
local results = {}

local function check(condition, message)
    assert(condition, message)
    table.insert(results, message)
end

local function run()
    vim.cmd('filetype on')
    local plugin = dofile(project_directory .. '/nvim/workflow.lua')
    vim.cmd.edit(project_directory .. '/examples/playground.workflow')
    local buffer = vim.api.nvim_get_current_buf()
    check(vim.bo[buffer].filetype == 'sudoc', 'Recognizes .workflow files')
    check(vim.bo[buffer].shiftwidth == 4 and vim.bo[buffer].expandtab, 'Uses four-space indentation')

    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, {
        '@WORKFLOW:', '    ELSE:', '        DO inspect',
    })
    vim.cmd.WorkflowLint()
    local found_error = vim.wait(5000, function()
        local diagnostics = vim.diagnostic.get(buffer, { namespace = plugin.namespace })
        for _, diagnostic in ipairs(diagnostics) do
            if diagnostic.code == 'orphan-else' and diagnostic.lnum == 1 then
                return true
            end
        end
        return false
    end, 20)
    check(found_error, 'Shows structural errors for unsaved buffer text')

    local original = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
    vim.cmd.WorkflowFormat()
    check(vim.deep_equal(original, vim.api.nvim_buf_get_lines(buffer, 0, -1, false)), 'Refuses to format invalid documents')

    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { '@workflow:', '  do inspect' })
    -- Trigger the actual live-edit event rather than calling the linter directly.
    vim.api.nvim_exec_autocmds('TextChanged', { buffer = buffer })
    local cleared = vim.wait(5000, function()
        return #vim.diagnostic.get(buffer, { namespace = plugin.namespace }) == 0
    end, 20)
    check(cleared, 'Live editing clears outdated diagnostics')

    vim.cmd.WorkflowFormat()
    check(vim.deep_equal(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), {
        '@WORKFLOW:', '    DO inspect',
    }), 'Formatting changes the buffer to canonical syntax')

    local disk_lines = vim.fn.readfile(project_directory .. '/examples/playground.workflow')
    check(disk_lines[2] == '@WORKFLOW:', 'Formatting does not save the buffer automatically')

    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, {
        '@WORKFLOW:', '    DEFINE $MESSAGE AS the message body', '    DO send $MESSAGE',
    })
    local workflow_syntax_name = vim.fn.synIDattr(vim.fn.synID(1, 1, 1), 'name')
    check(workflow_syntax_name == 'WorkflowSymbol', 'Highlights the global workflow symbol')
    local variable_syntax_name = vim.fn.synIDattr(vim.fn.synID(2, 12, 1), 'name')
    check(variable_syntax_name == 'WorkflowVariable', 'Highlights variable references')

    -- An older in-flight lint result must never replace the newer buffer state.
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { '@WORKFLOW:', '    ELSE:', '        DO inspect' })
    vim.cmd.WorkflowLint()
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { '@WORKFLOW:', '    DO inspect' })
    vim.cmd.WorkflowLint()
    vim.wait(500, function() return false end, 20)
    check(#vim.diagnostic.get(buffer, { namespace = plugin.namespace }) == 0, 'Discards stale diagnostic results after further edits')

    vim.cmd('edit! ' .. project_directory .. '/examples/dropdown-sync.sudoc')
    buffer = vim.api.nvim_get_current_buf()
    check(vim.bo[buffer].filetype == 'sudoc', 'Recognizes .sudoc files')
    check(vim.fn.exists(':SudocLint') == 2 and vim.fn.exists(':SudocFormat') == 2, 'Provides Sudoc commands')
    check(vim.fn.exists(':WorkflowLint') == 2 and vim.fn.exists(':WorkflowFormat') == 2, 'Preserves legacy command aliases')
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, {
        '@WORKFLOW:', '    VERSION 1', '    ON FAILURE STOP', '    DO improvise',
    })
    vim.cmd.SudocLint()
    check(vim.wait(5000, function()
        for _, diagnostic in ipairs(vim.diagnostic.get(buffer, { namespace = plugin.namespace })) do
            if diagnostic.lnum == 3 then return true end
        end
        return false
    end, 20), 'Executable grammar rejects undeclared freedom')
    original = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
    vim.cmd.SudocFormat()
    check(vim.deep_equal(original, vim.api.nvim_buf_get_lines(buffer, 0, -1, false)), 'Refuses to format invalid executable syntax')
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, {
        '@WORKFLOW:', '  VERSION 1', '  INPUT $PORTAL AS Number', '  ON FAILURE STOP',
        '  CHECK portal_matches:', '    WITH portal = $PORTAL', '    WITH expected = 100001',
    })
    vim.cmd.SudocLint()
    check(vim.wait(5000, function()
        return #vim.diagnostic.get(buffer, { namespace = plugin.namespace }) == 0
    end, 20), 'Valid executable source clears old diagnostics')
    vim.cmd.SudocFormat()
    check(vim.api.nvim_buf_get_lines(buffer, 4, 6, false)[2] == '        WITH portal = $PORTAL', 'Formats executable source with canonical indentation')
    check(vim.fn.synIDattr(vim.fn.synID(5, 5, 1), 'name') == 'WorkflowKeyword', 'Highlights executable check keywords')
    check(vim.bo[buffer].modified, 'Executable formatting leaves changes unsaved')

    print('Neovim integration: ' .. #results .. ' checks passed')
end

local passed, failure = pcall(run)
if not passed then
    io.stderr:write(tostring(failure) .. '\n')
    vim.cmd('cquit 1')
else
    vim.cmd('qa!')
end
