-- Local authoring plugin. No workflow instructions are executed.
local module_path = debug.getinfo(1, 'S').source:sub(2)
local project_directory = vim.fn.fnamemodify(module_path, ':p:h:h')
local cli_path = project_directory .. '/cli.js'
local namespace = vim.api.nvim_create_namespace('workflow-experiment')
local readiness_namespace = vim.api.nvim_create_namespace('workflow-readiness')
local semantic_namespace = vim.api.nvim_create_namespace('workflow-semantic-review')
local group = vim.api.nvim_create_augroup('WorkflowExperiment', { clear = true })
local requests = { lint = {}, check = {}, review = {} }
local completions = {}
local plugin = { namespace = namespace, readiness_namespace = readiness_namespace, semantic_namespace = semantic_namespace }

local function report_error(message)
    vim.notify('Workflow: ' .. message, vim.log.levels.ERROR)
end

local function buffer_text(buffer)
    return table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), '\n') .. '\n'
end

local function line_text(buffer, line)
    return vim.api.nvim_buf_get_lines(buffer, line, line + 1, false)[1] or ''
end

-- Neovim indexes bytes; JavaScript language services index UTF-16 code units.
local function byte_column(text, column)
    local ok, index = pcall(vim.str_byteindex, text, 'utf-16', math.max(0, column), false)
    if ok then return index end
    ok, index = pcall(vim.str_byteindex, text, math.max(0, column), true)
    return ok and index or #text
end

local function utf16_column(text, column)
    local ok, index = pcall(vim.str_utfindex, text, 'utf-16', column, false)
    if ok then return index end
    local _, utf16 = vim.str_utfindex(text, column)
    return utf16
end

local function decode_report(result, semantic_result)
    if result.code ~= 0 and result.code ~= 1 and not semantic_result then
        report_error('Authoring service failed. Check that Node.js is available in Neovim\'s PATH.')
        return nil
    end
    local ok, report = pcall(vim.json.decode, result.stdout)
    if not ok or type(report) ~= 'table' then
        report_error('The authoring service returned an invalid response.')
        return nil
    end
    return report
end

local function publish(buffer, target_namespace, items, source)
    local diagnostics = {}
    local severities = { error = vim.diagnostic.severity.ERROR, warning = vim.diagnostic.severity.WARN,
        information = vim.diagnostic.severity.INFO, info = vim.diagnostic.severity.INFO, hint = vim.diagnostic.severity.HINT }
    for _, item in ipairs(items or {}) do
        local line = math.min(vim.api.nvim_buf_line_count(buffer) - 1, math.max(0, (item.line or 1) - 1))
        local last_line = math.min(vim.api.nvim_buf_line_count(buffer) - 1, math.max(line, (item.endLine or item.line or 1) - 1))
        local column = byte_column(line_text(buffer, line), (item.column or 1) - 1)
        local last_column = byte_column(line_text(buffer, last_line), (item.endColumn or (item.column or 1) + 1) - 1)
        table.insert(diagnostics, {
            lnum = line, col = column, end_lnum = last_line, end_col = last_column,
            severity = severities[item.severity] or vim.diagnostic.severity.ERROR,
            message = item.message, code = item.code,
            source = source .. (item.category and (' (' .. item.category .. ')') or ''),
            user_data = { category = item.category },
        })
    end
    vim.diagnostic.set(target_namespace, buffer, diagnostics)
end

local function diagnose(buffer, command, target_namespace)
    if not vim.api.nvim_buf_is_valid(buffer) then return end
    requests[command][buffer] = (requests[command][buffer] or 0) + 1
    local request = requests[command][buffer]
    local changed_tick = vim.api.nvim_buf_get_changedtick(buffer)
    if command == 'review' then
        vim.diagnostic.reset(semantic_namespace, buffer)
        vim.b[buffer].workflow_review_status = 'reviewing'
    elseif command == 'check' then
        vim.b[buffer].workflow_readiness = 'checking'
    end
    vim.system({ 'node', cli_path, command, '-', '--json' }, {
        text = true, stdin = buffer_text(buffer), timeout = command == 'review' and 60000 or 5000,
    }, function(result)
        vim.schedule(function()
            if not vim.api.nvim_buf_is_valid(buffer) or requests[command][buffer] ~= request then return end
            if vim.api.nvim_buf_get_changedtick(buffer) ~= changed_tick then return end
            local report = decode_report(result, command == 'review')
            if not report or type(report.diagnostics) ~= 'table' then
                if command == 'review' then vim.b[buffer].workflow_review_status = 'unavailable' end
                return
            end
            publish(buffer, target_namespace, report.diagnostics, command == 'review' and 'Workflow semantic review' or 'Workflow')
            if command == 'review' then
                vim.b[buffer].workflow_review_status = report.status or 'unreviewed'
                vim.b[buffer].workflow_review_reason = report.reason
                local detail = report.reason and (' (' .. report.reason .. ')') or ''
                if report.completedQuestions and report.totalQuestions then
                    detail = detail .. ' — ' .. report.completedQuestions .. '/' .. report.totalQuestions .. ' questions'
                end
                vim.notify('Workflow semantic review: ' .. vim.b[buffer].workflow_review_status .. detail)
            elseif command == 'check' then
                vim.b[buffer].workflow_readiness = report.ready and 'ready' or 'incomplete'
                local errors = 0
                for _, diagnostic in ipairs(report.diagnostics) do
                    if diagnostic.severity == 'error' then errors = errors + 1 end
                end
                vim.notify('Workflow readiness: ' .. errors .. ' errors.')
            end
        end)
    end)
end

function plugin.lint(buffer) diagnose(buffer, 'lint', namespace) end
function plugin.check(buffer) diagnose(buffer, 'check', readiness_namespace) end
function plugin.review(buffer) diagnose(buffer, 'review', semantic_namespace) end

-- Formatting edits the current buffer and preserves the user's explicit save step.
function plugin.format(buffer)
    local result = vim.system({ 'node', cli_path, 'format', '-' }, {
        text = true, stdin = buffer_text(buffer), timeout = 5000,
    }):wait()
    if result.code ~= 0 then
        vim.notify('Workflow: fix syntax errors before formatting; run :WorkflowLint.', vim.log.levels.WARN)
        plugin.lint(buffer)
        return
    end
    local lines = vim.split(result.stdout, '\n', { plain = true })
    if lines[#lines] == '' then table.remove(lines) end
    local view = vim.fn.winsaveview()
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
    vim.fn.winrestview(view)
    plugin.lint(buffer)
end

local function query(buffer, command)
    local cursor = vim.api.nvim_win_get_cursor(0)
    local result = vim.system({ 'node', cli_path, command, '-', '--line', tostring(cursor[1]),
        '--column', tostring(utf16_column(line_text(buffer, cursor[1] - 1), cursor[2]) + 1), '--json' },
        { text = true, stdin = buffer_text(buffer), timeout = 5000 }):wait()
    if result.code ~= 0 then report_error('Unable to read language service results.'); return nil end
    local ok, report = pcall(vim.json.decode, result.stdout)
    return ok and report ~= vim.NIL and report or nil
end

local function plain_snippet(text)
    return text:gsub('%${%d+:([^}]+)}', '%1'):gsub('%${%d+}', ''):gsub('%$%d+', ''):gsub('\\%$', '$')
end

-- Native omnifunc: CTRL-X CTRL-O; no completion plugin or user configuration required.
function plugin.complete(findstart, base)
    local buffer = vim.api.nvim_get_current_buf()
    if findstart == 1 then
        local cursor = vim.api.nvim_win_get_cursor(0)
        local entries = query(buffer, 'complete') or {}
        entries = entries.items or entries
        completions[buffer] = entries
        if #entries == 0 then return cursor[2] end
        return byte_column(line_text(buffer, cursor[1] - 1), entries[1].range.column - 1)
    end
    local items = {}
    for _, entry in ipairs(completions[buffer] or {}) do
        local insertion = entry.snippet and plain_snippet(entry.insertText) or entry.insertText
        local first_line = insertion:match('^[^\n]*') or insertion
        if base == '' or first_line:sub(1, #base):lower() == base:lower() or entry.label:sub(1, #base):lower() == base:lower() then
        table.insert(items, { word = first_line, abbr = entry.label, menu = entry.detail or '',
            info = entry.detail or '', dup = 1,
            user_data = vim.json.encode({ workflow = true, text = entry.insertText, snippet = entry.snippet or false,
                first_line = first_line, insertion = insertion }) })
        end
    end
    return items
end
_G.WorkflowOmnifunc = plugin.complete

local function finish_completion(buffer)
    local item = vim.v.completed_item
    if not item or not item.user_data or item.user_data == '' then return end
    local ok, data = pcall(vim.json.decode, item.user_data)
    if not ok or type(data) ~= 'table' or not data.workflow then return end
    if not data.text:find('\n', 1, true) and not data.snippet then return end
    local cursor = vim.api.nvim_win_get_cursor(0)
    local start = cursor[2] - #data.first_line
    if start < 0 or line_text(buffer, cursor[1] - 1):sub(start + 1, cursor[2]) ~= data.first_line then return end
    vim.api.nvim_buf_set_text(buffer, cursor[1] - 1, start, cursor[1] - 1, cursor[2], { '' })
    vim.api.nvim_win_set_cursor(0, { cursor[1], start })
    if data.snippet and vim.snippet and vim.snippet.expand then
        vim.snippet.expand(data.text)
    else
        local lines = vim.split(data.insertion, '\n', { plain = true })
        vim.api.nvim_buf_set_text(buffer, cursor[1] - 1, start, cursor[1] - 1, start, lines)
        vim.api.nvim_win_set_cursor(0, { cursor[1] + #lines - 1, #lines == 1 and start + #lines[1] or #lines[#lines] })
    end
end

function plugin.definition(buffer)
    local location = query(buffer, 'definition')
    if not location then vim.notify('Workflow: no declaration at the cursor.'); return end
    vim.cmd("normal! m'")
    vim.api.nvim_win_set_cursor(0, { location.line, byte_column(line_text(buffer, location.line - 1), location.column - 1) })
end

function plugin.hover(buffer)
    local result = query(buffer, 'hover')
    if not result then vim.notify('Workflow: no symbol information at the cursor.'); return end
    local contents = type(result.contents) == 'table' and table.concat(result.contents, '\n') or result.contents
    vim.lsp.util.open_floating_preview(vim.split(contents, '\n', { plain = true }), 'markdown', { border = 'rounded' })
end

function plugin.template(buffer, name)
    local result = vim.system({ 'node', cli_path, 'template', name }, { text = true, timeout = 5000 }):wait()
    if result.code ~= 0 then report_error('Unknown template. Choose workflow, sms, or send_sms.'); return end
    local cursor = vim.api.nvim_win_get_cursor(0)
    local current = line_text(buffer, cursor[1] - 1)
    local indent = current:match('^%s*') or ''
    local text = result.stdout:gsub('\n$', '')
    local lines = vim.split(text, '\n', { plain = true })
    for index = 2, #lines do lines[index] = indent .. lines[index] end
    local start = current:match('^%s*$') and #current or cursor[2]
    vim.api.nvim_buf_set_text(buffer, cursor[1] - 1, start, cursor[1] - 1, start, lines)
    plugin.lint(buffer)
end

-- Every edit invalidates semantic findings immediately, including pending requests.
local function invalidate(buffer)
    for _, kind in ipairs({ 'check', 'review' }) do requests[kind][buffer] = (requests[kind][buffer] or 0) + 1 end
    vim.diagnostic.reset(readiness_namespace, buffer)
    vim.diagnostic.reset(semantic_namespace, buffer)
    vim.b[buffer].workflow_review_status = 'unreviewed'
    vim.b[buffer].workflow_readiness = 'unchecked'
end

local function schedule_lint(buffer)
    invalidate(buffer)
    requests.lint[buffer] = (requests.lint[buffer] or 0) + 1
    local request = requests.lint[buffer]
    vim.defer_fn(function()
        if vim.api.nvim_buf_is_valid(buffer) and requests.lint[buffer] == request then plugin.lint(buffer) end
    end, 200)
end

local function attach(buffer)
    if vim.fn.executable('node') ~= 1 then report_error('Node.js 20+ is required; node was not found in PATH.'); return end
    vim.bo[buffer].expandtab = true
    vim.bo[buffer].shiftwidth = 4
    vim.bo[buffer].softtabstop = 4
    vim.bo[buffer].autoindent = true
    vim.bo[buffer].commentstring = '# %s'
    vim.bo[buffer].omnifunc = 'v:lua.WorkflowOmnifunc'
    vim.b[buffer].workflow_review_status = 'unreviewed'
    vim.api.nvim_buf_call(buffer, function()
        vim.cmd([[
            syntax case ignore
            syntax match WorkflowKeyword /^\s*\zs\%(FOR\s\+EACH\|CONTRACT\|INPUT\|OUTPUT\|CONDITION\|DECIDE\|WHEN\|WITH\|PRODUCES\|PROVIDE\|ON\|EXIT\|DEFINE\|WHERE\|IF\|ELSE\|DO\|THEN\|USING\|NOTE\|STOP\)\>/
            syntax match WorkflowOperator /\<\%(AND\|OR\|NOT\|IN\|AS\|FROM\)\>\|===\|==\|!=\|<=\|>=\|[<>]/
            syntax match WorkflowOutcome /\<\%(true\|false\|unknown\|success\|failure\|review\)\>/
            syntax case match
            syntax match WorkflowSymbol /\%(^\|[^A-Za-z0-9._%+-]\)\zs@[A-Z][A-Z0-9_]*/
            syntax match WorkflowVariable /\$[A-Z][A-Z0-9_]*/
            syntax region WorkflowString start=/"/ skip=/\\"/ end=/"/ oneline
            syntax match WorkflowUrl /https\?:\/\/\S\+/
            syntax match WorkflowComment /^\s*#.*/
            highlight default link WorkflowKeyword Keyword
            highlight default link WorkflowOperator Operator
            highlight default link WorkflowOutcome Constant
            highlight default link WorkflowSymbol Function
            highlight default link WorkflowVariable Identifier
            highlight default link WorkflowString String
            highlight default link WorkflowUrl Underlined
            highlight default link WorkflowComment Comment
        ]])
    end)
    local commands = { WorkflowLint = plugin.lint, WorkflowCheck = plugin.check, WorkflowReview = plugin.review,
        WorkflowFormat = plugin.format, WorkflowDefinition = plugin.definition, WorkflowHover = plugin.hover }
    for name, action in pairs(commands) do
        vim.api.nvim_buf_create_user_command(buffer, name, function() action(buffer) end, { force = true })
    end
    vim.api.nvim_buf_create_user_command(buffer, 'WorkflowTemplate', function(options) plugin.template(buffer, options.args) end,
        { nargs = 1, force = true, complete = function() return { 'workflow', 'sms', 'send_sms' } end })
    vim.api.nvim_clear_autocmds({ group = group, buffer = buffer })
    vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI', 'BufWritePost' }, {
        group = group, buffer = buffer, callback = function() schedule_lint(buffer) end,
    })
    vim.api.nvim_create_autocmd('CompleteDone', { group = group, buffer = buffer, callback = function() finish_completion(buffer) end })
    vim.api.nvim_create_autocmd('BufWipeout', {
        group = group, buffer = buffer,
        callback = function()
            for _, pending in pairs(requests) do pending[buffer] = nil end
            completions[buffer] = nil
            for _, id in ipairs({ namespace, readiness_namespace, semantic_namespace }) do vim.diagnostic.reset(id, buffer) end
        end,
    })
    plugin.lint(buffer)
end

for _, id in ipairs({ namespace, readiness_namespace, semantic_namespace }) do
    vim.diagnostic.config({ underline = true, signs = true, virtual_text = true }, id)
end
vim.filetype.add({ extension = { workflow = 'workflow' } })
vim.api.nvim_create_autocmd('FileType', { group = group, pattern = 'workflow', callback = function(event) attach(event.buf) end })
for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buffer) then
        local filename = vim.api.nvim_buf_get_name(buffer)
        if vim.bo[buffer].filetype == 'workflow' then attach(buffer)
        elseif filename:match('%.workflow$') then vim.bo[buffer].filetype = 'workflow' end
    end
end
return plugin
