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
    check(vim.bo[buffer].filetype == 'workflow', 'Recognizes .workflow files')
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


    check(vim.bo[buffer].omnifunc == 'v:lua.WorkflowOmnifunc', 'Provides native completion without a completion plugin')
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, {
        '@WORKFLOW:', '    DEFINE $MESSAGE AS the message body', '    DO send $MES ',
    })
    vim.api.nvim_win_set_cursor(0, { 3, 16 })
    local completion_start = plugin.complete(1, '')
    local items = plugin.complete(0, '$MES')
    local has_message = false
    for _, item in ipairs(items) do if item.word == '$MESSAGE' then has_message = true end end
    check(completion_start == 12 and has_message, 'Completes scoped variables with the correct replacement span')
    vim.api.nvim_buf_set_lines(buffer, 2, 3, false, { '    DO send $MESSAGE' })
    vim.api.nvim_win_set_cursor(0, { 3, 14 })
    vim.cmd.WorkflowDefinition()
    check(vim.api.nvim_win_get_cursor(0)[1] == 2, 'Jumps from a variable use to its declaration')

    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { '@WORKFLOW:', '    IF' })
    vim.api.nvim_win_set_cursor(0, { 2, 5 })
    vim.o.completeopt = 'menuone,noselect'
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('A<C-x><C-o><C-n><C-y><Esc>', true, false, true), 'x', false)
    check(vim.deep_equal(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), {
        '@WORKFLOW:', '    IF condition:', '        ',
    }), 'Accepting native completion filters the prefix and expands a multiline block')

    local unicode_line = '    DO inspect 🙂 $MES '
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, {
        '@WORKFLOW:', '    DEFINE $MESSAGE AS message text', unicode_line,
    })
    vim.api.nvim_win_set_cursor(0, { 3, #unicode_line - 1 })
    local unicode_start = plugin.complete(1, '')
    local unicode_items = plugin.complete(0, '$MES')
    check(unicode_start == unicode_line:find('$', 1, true) - 1 and unicode_items[1].word == '$MESSAGE',
        'Converts Unicode byte positions to UTF-16 for language-service completion')

    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { '' })
    vim.api.nvim_win_set_cursor(0, { 1, 0 })
    vim.cmd('WorkflowTemplate sms')
    local inserted = table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), '\n')
    check(inserted:find('CONTRACT 1', 1, true) ~= nil and inserted:find('DO send_sms:', 1, true) ~= nil,
        'Inserts the SMS template as visible, editable source')
    vim.cmd.WorkflowCheck()
    check(vim.wait(5000, function()
        return vim.b[buffer].workflow_readiness == 'ready' and #vim.diagnostic.get(buffer, { namespace = plugin.readiness_namespace }) == 0
    end, 20), 'The complete SMS template passes readiness checks')

    -- Review fixtures stay in-process: no network, credentials, or real documents.
    local real_system = vim.system
    local review_callbacks = {}
    vim.system = function(command, options, callback)
        if command[3] == 'review' then
            table.insert(review_callbacks, callback)
            return {}
        end
        return real_system(command, options, callback)
    end
    local function review_report(message)
        return { code = 0, stdout = vim.json.encode({ status = 'reviewed', diagnostics = {
            { line = 1, column = 1, endLine = 1, endColumn = 9, severity = 'warning',
                code = 'semantic-test', category = 'semantic', message = message },
        } }) }
    end
    vim.cmd.WorkflowReview()
    review_callbacks[1](review_report('A model concern'))
    check(vim.wait(1000, function()
        return #vim.diagnostic.get(buffer, { namespace = plugin.semantic_namespace }) == 1
    end, 20), 'Publishes model concerns in a separate diagnostic namespace')
    local concern = vim.diagnostic.get(buffer, { namespace = plugin.semantic_namespace })[1]
    check(concern.col == 0 and concern.end_col == 8, 'Preserves precise exclusive diagnostic ranges')
    vim.cmd.WorkflowReview()
    vim.api.nvim_buf_set_lines(buffer, 0, 1, false, { '# changed' })
    vim.api.nvim_exec_autocmds('TextChanged', { buffer = buffer })
    review_callbacks[2](review_report('Stale concern'))
    vim.wait(100, function() return false end, 20)
    check(#vim.diagnostic.get(buffer, { namespace = plugin.semantic_namespace }) == 0
        and vim.b[buffer].workflow_review_status == 'unreviewed', 'Discards semantic reviews after an edit')
    vim.cmd.WorkflowReview()
    vim.cmd.WorkflowReview()
    review_callbacks[4](review_report('Newer concern'))
    review_callbacks[3](review_report('Older concern'))
    check(vim.wait(1000, function()
        local found = vim.diagnostic.get(buffer, { namespace = plugin.semantic_namespace })
        return #found == 1 and found[1].message == 'Newer concern'
    end, 20), 'An older review cannot overwrite a newer review for the same text')
    vim.cmd.WorkflowReview()
    review_callbacks[5]({ code = 2, stdout = vim.json.encode({ status = 'unavailable', diagnostics = {} }) })
    check(vim.wait(1000, function() return vim.b[buffer].workflow_review_status == 'unavailable' end, 20),
        'Reports unavailable semantic review without claiming completion')
    vim.api.nvim_buf_set_lines(buffer, 0, 1, false, { '# 🙂 evidence' })
    vim.cmd.WorkflowReview()
    review_callbacks[6]({ code = 0, stdout = vim.json.encode({ status = 'reviewed', diagnostics = {
        { line = 1, column = 6, endLine = 1, endColumn = 14, severity = 'information', message = 'Unicode range' },
    } }) })
    check(vim.wait(1000, function()
        local diagnostics = vim.diagnostic.get(buffer, { namespace = plugin.semantic_namespace })
        return #diagnostics == 1 and diagnostics[1].col == 7 and diagnostics[1].end_col == 15
    end, 20), 'Converts UTF-16 diagnostic ranges to Neovim byte positions')
    vim.system = real_system

    print('Neovim integration: ' .. #results .. ' checks passed')
end

local passed, failure = pcall(run)
if not passed then
    io.stderr:write(tostring(failure) .. '\n')
    vim.cmd('cquit 1')
else
    vim.cmd('qa!')
end
