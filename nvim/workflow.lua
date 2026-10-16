-- Local authoring plugin. No workflow instructions are executed.
local module_path = debug.getinfo(1, 'S').source:sub(2)
local project_directory = vim.fn.fnamemodify(module_path, ':p:h:h')
local cli_path = project_directory .. '/cli.js'
local namespace = vim.api.nvim_create_namespace('sudoc')
local group = vim.api.nvim_create_augroup('Sudoc', { clear = true })
local requests = {}
local plugin = { namespace = namespace }

-- Give editor failures an actionable message without echoing authored content.
local function report_error(message)
    vim.notify('Sudoc: ' .. message, vim.log.levels.ERROR)
end

local function buffer_text(buffer)
    local lines = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
    return table.concat(lines, '\n') .. '\n'
end

-- Each edit invalidates earlier results, even if their processes finish last.
function plugin.lint(buffer)
    if not vim.api.nvim_buf_is_valid(buffer) then
        return
    end
    requests[buffer] = (requests[buffer] or 0) + 1
    local request = requests[buffer]
    local changed_tick = vim.api.nvim_buf_get_changedtick(buffer)
    local source = buffer_text(buffer)
    local command = { 'node', cli_path, 'lint', '-', '--json' }

    vim.system(command, { text = true, stdin = source, timeout = 5000 }, function(result)
        vim.schedule(function()
            if not vim.api.nvim_buf_is_valid(buffer) or requests[buffer] ~= request then
                return
            end
            if vim.api.nvim_buf_get_changedtick(buffer) ~= changed_tick then
                return
            end
            if result.code ~= 0 and result.code ~= 1 then
                report_error('Linter failed. Check that Node.js is available in Neovim\'s PATH.')
                return
            end
            local decoded, report = pcall(vim.json.decode, result.stdout)
            if not decoded or type(report) ~= 'table' or type(report.diagnostics) ~= 'table' then
                report_error('The linter returned an invalid response.')
                return
            end
            local diagnostics = {}
            for _, item in ipairs(report.diagnostics) do
                local severity = vim.diagnostic.severity.ERROR
                if item.severity == 'warning' then
                    severity = vim.diagnostic.severity.WARN
                end
                table.insert(diagnostics, {
                    lnum = item.line - 1,
                    col = item.column - 1,
                    severity = severity,
                    message = item.message,
                    code = item.code,
                    source = 'Sudoc',
                })
            end
            vim.diagnostic.set(namespace, buffer, diagnostics)
        end)
    end)
end

-- Formatting edits the current buffer and preserves the user's explicit save step.
function plugin.format(buffer)
    local command = { 'node', cli_path, 'format', '-' }
    local result = vim.system(command, { text = true, stdin = buffer_text(buffer), timeout = 5000 }):wait()
    if result.code ~= 0 then
        vim.notify('Sudoc: fix syntax errors before formatting; run :SudocLint.', vim.log.levels.WARN)
        plugin.lint(buffer)
        return
    end
    local lines = vim.split(result.stdout, '\n', { plain = true })
    if lines[#lines] == '' then
        table.remove(lines)
    end
    local view = vim.fn.winsaveview()
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
    vim.fn.winrestview(view)
    plugin.lint(buffer)
end

-- Coalesce rapid edits into one lint request after 200 ms of inactivity.
local function schedule_lint(buffer)
    requests[buffer] = (requests[buffer] or 0) + 1
    local request = requests[buffer]
    vim.defer_fn(function()
        if vim.api.nvim_buf_is_valid(buffer) and requests[buffer] == request then
            plugin.lint(buffer)
        end
    end, 200)
end

-- Buffer-local options and syntax keep the user's other filetypes untouched.
local function attach(buffer)
    if vim.fn.executable('node') ~= 1 then
        report_error('Node.js 20+ is required; node was not found in PATH.')
        return
    end
    vim.bo[buffer].expandtab = true
    vim.bo[buffer].shiftwidth = 4
    vim.bo[buffer].softtabstop = 4
    vim.bo[buffer].autoindent = true
    vim.bo[buffer].commentstring = '# %s'
    vim.api.nvim_buf_call(buffer, function()
        vim.cmd([[
            syntax case ignore
            syntax match WorkflowKeyword /^\s*\zs\%(FOR\s\+EACH\|DEFINE\|WHERE\|IF\|ELSE\|DO\|THEN\|USING\|NOTE\|STOP\|VERSION\|INPUT\|OUTPUT\|RUN\|WITH\|CHECK\|INTERPRET\|QUESTION\|LIMIT\|EVIDENCE\|ACCEPT\|JEV\|CONFIDENCE\|ON\|UNKNOWN\|REVIEW\|REJECT\|FAILURE\|PROVIDE\|AS\)\>/
            syntax match WorkflowOperator /\<\%(AND\|OR\|NOT\|IN\)\>\|===\|==\|!=/
            syntax case match
            syntax match WorkflowSymbol /\%(^\|[^A-Za-z0-9._%+-]\)\zs@[A-Z][A-Z0-9_]*/
            syntax match WorkflowVariable /\$[A-Za-z][A-Za-z0-9_.]*/
            syntax region WorkflowString start=/"/ skip=/\\"/ end=/"/ oneline
            syntax match WorkflowUrl /https\?:\/\/\S\+/
            syntax match WorkflowComment /^\s*#.*/
            highlight default link WorkflowKeyword Keyword
            highlight default link WorkflowOperator Operator
            highlight default link WorkflowSymbol Function
            highlight default link WorkflowVariable Identifier
            highlight default link WorkflowString String
            highlight default link WorkflowUrl Underlined
            highlight default link WorkflowComment Comment
        ]])
    end)
    for _, name in ipairs({ 'SudocLint', 'WorkflowLint' }) do
        vim.api.nvim_buf_create_user_command(buffer, name, function()
            plugin.lint(buffer)
        end, { desc = 'Check this Sudoc document without running it', force = true })
    end
    for _, name in ipairs({ 'SudocFormat', 'WorkflowFormat' }) do
        vim.api.nvim_buf_create_user_command(buffer, name, function()
            plugin.format(buffer)
        end, { desc = 'Format this Sudoc document without saving it', force = true })
    end
    vim.api.nvim_clear_autocmds({ group = group, buffer = buffer })
    vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI', 'BufWritePost' }, {
        group = group,
        buffer = buffer,
        callback = function() schedule_lint(buffer) end,
    })
    vim.api.nvim_create_autocmd('BufWipeout', {
        group = group,
        buffer = buffer,
        callback = function()
            requests[buffer] = nil
            vim.diagnostic.reset(namespace, buffer)
        end,
    })
    plugin.lint(buffer)
end

vim.diagnostic.config({ underline = true, signs = true, virtual_text = true }, namespace)
vim.filetype.add({ extension = { workflow = 'sudoc', sudoc = 'sudoc' } })
vim.api.nvim_create_autocmd('FileType', {
    group = group,
    pattern = { 'sudoc', 'workflow' },
    callback = function(event) attach(event.buf) end,
})

-- Loading with :luafile after opening a workflow should work too.
for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buffer) then
        local filename = vim.api.nvim_buf_get_name(buffer)
        if vim.bo[buffer].filetype == 'sudoc' or vim.bo[buffer].filetype == 'workflow' then
            attach(buffer)
        elseif filename:match('%.workflow$') or filename:match('%.sudoc$') then
            vim.bo[buffer].filetype = 'sudoc'
        end
    end
end

return plugin
