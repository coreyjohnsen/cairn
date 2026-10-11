import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkFile, checkNotice } from '../src/main/agent/checks'
import { FailureTracker } from '../src/main/agent/failures'
import { finishReport, ranChecks, verifyDoneSteps } from '../src/main/agent/finish'
import { checkReferences, findMissingIds, findMissingMembers, findNamespaces, referenceText } from '../src/main/agent/references'
import { planningTools } from '../src/main/tools/planning'
import { emptyPageHint } from '../src/main/tools/web'
import { pageHasProblems, pageReportText, verifyTools } from '../src/main/tools/verify'
import type { PageReport } from '../src/main/tools/types'
import { applyPlanUpdate, newlyDone, planText, withStepStatus } from '../src/shared/plan'
import type { ConversationPlan } from '../src/shared/types'
import { makeCtx } from './helpers/ctx'

let ws: string
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-verify-'))
})
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }))

const write = (rel: string, text: string): string => {
  const abs = path.join(ws, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
  return abs
}

describe('checking a file right after it is written', () => {
  it('passes valid JSON and JavaScript, and says nothing', async () => {
    expect((await checkFile(write('a.json', '{"a":1}'), ws))?.problems).toEqual([])
    const js = await checkFile(write('a.js', 'const x = (() => { return { a: 1 } })()\nconsole.log(x)\n'), ws)
    expect(js).toEqual({ kind: 'JavaScript syntax', problems: [] })
    expect(checkNotice('a.js', js)).toBe('')
  })

  it('finds the doubled parenthesis that slipped into a real project', async () => {
    const abs = write('roster.js', "const starters = positions.filter(p => !p.startsWith('BN') && p !== 'FLEX'));\n")
    const c = await checkFile(abs, ws)
    expect(c?.problems.length).toBe(1)
    expect(c?.problems[0]).toMatch(/SyntaxError/)
    expect(c?.problems[0]).toContain('roster.js')
    expect(checkNotice('roster.js', c)).toContain('[Check failed: JavaScript syntax of roster.js')
  })

  it('finds broken JSON and unbalanced CSS', async () => {
    expect((await checkFile(write('b.json', '{"a":'), ws))?.problems[0]).toBeTruthy()
    expect((await checkFile(write('a.css', 'a { color: red;\n'), ws))?.problems[0]).toMatch(/never closed/)
    expect((await checkFile(write('b.css', 'a { color: red; }\n}\n'), ws))?.problems[0]).toMatch(/line 2/)
    expect((await checkFile(write('c.css', '/* } */ a::after { content: "}"; }\n'), ws))?.problems).toEqual([])
  })

  it('checks a page: missing script, broken inline script, repeated id', async () => {
    write('js/app.js', 'x')
    const html = `<!doctype html><html><head><link rel="stylesheet" href="css/style.css"></head><body>
<div id="a"></div><div id="a"></div>
<script src="js/app.js"></script><script src="js/missing.js"></script><script src="https://cdn.example.com/x.js"></script>
<script>const x = ;</script>
</body></html>`
    const c = await checkFile(write('index.html', html), ws)
    const text = c!.problems.join('\n')
    expect(text).toContain('"css/style.css"')
    expect(text).toContain('"js/missing.js"')
    expect(text).not.toContain('cdn.example.com')
    expect(text).toContain('inline script #1')
    expect(text).toContain('"a" is used more than once')
    expect(text).not.toContain('js/app.js"')
  })

  it('has no opinion about files it cannot check', async () => {
    expect(await checkFile(write('notes.txt', 'hi'), ws)).toBeNull()
    expect(await checkFile(path.join(ws, 'nothing.js'), ws)).toBeNull()
  })
})

// The project from the chat that went wrong: modules written separately, called by names that were never defined.
const UTILS = `const Utils = (() => {
  function formatValue(v) { return String(v) }
  function setHTML(id, h) { document.getElementById(id).innerHTML = h }
  function showElement(id) {}
  return {
    formatValue,
    setHTML,
    showElement,
    getState: () => ({})
  }
})()
`
const API = `const API = {
  getLeague() {},
  getRosters: async (id) => [],
  ...extra
}
`
const API_CLOSED = `const API = {
  getLeague() {},
  getRosters: async (id) => [],
  'get-users': 1,
}
`
const APP = `// Utils.fromComment() is only a comment
function go() {
  Utils.showError('x')
  Utils.formatValue(1)
  Utils.showElement('tradeResult')
  API.getPlayers()
  API.getLeague()
  console.log('Utils.inString()')
  Utils.setHTML('missingEl', '')
  document.getElementById('present').click()
  document.querySelector('#alsoMissing .x')
  Utils.state = 5
}
`
const PAGE = `<!doctype html><body><div id="present"></div><div id="tradeResult"></div>
<script src="js/utils.js"></script></body>`

describe('finding calls to things that do not exist', () => {
  const files = [
    { rel: 'js/utils.js', text: UTILS },
    { rel: 'js/api.js', text: API_CLOSED },
    { rel: 'js/app.js', text: APP },
    { rel: 'index.html', text: PAGE }
  ]

  it('reads the names an IIFE module and an object module offer', () => {
    const ns = findNamespaces(files)
    expect([...ns.get('Utils')!.keys].sort()).toEqual(['formatValue', 'getState', 'setHTML', 'showElement'])
    expect([...ns.get('API')!.keys].sort()).toEqual(['get-users', 'getLeague', 'getRosters'])
  })

  it('leaves a module alone when it spreads in members it cannot see', () => {
    expect(findNamespaces([{ rel: 'api.js', text: API }]).has('API')).toBe(false)
  })

  it('reports Utils.showError and API.getPlayers, with where and what is offered', () => {
    const p = findMissingMembers(files)
    const msgs = p.map((x) => `${x.rel}:${x.line} ${x.message}`)
    expect(msgs.some((m) => m.startsWith('js/app.js:3 Utils.showError is used') && m.includes('It offers: formatValue, getState, setHTML, showElement'))).toBe(true)
    expect(msgs.some((m) => m.startsWith('js/app.js:6 API.getPlayers'))).toBe(true)
    // Not these: a real member, a comment, a string, and assigning a new member.
    expect(p.length).toBe(2)
  })

  it('suggests the nearest real name', () => {
    const p = findMissingMembers([{ rel: 'u.js', text: UTILS }, { rel: 'a.js', text: 'Utils.formatVal(1)' }])
    expect(p[0].message).toContain('Did you mean Utils.formatValue?')
  })

  it('reports element ids that no page defines', () => {
    const p = findMissingIds(files)
    const ids = p.map((x) => x.message.match(/"([^"]+)"/)![1]).sort()
    expect(ids).toEqual(['alsoMissing', 'missingEl'])
  })

  it('counts ids that a script builds as defined', () => {
    const p = findMissingIds([
      { rel: 'index.html', text: '<body></body>' },
      { rel: 'a.js', text: "el.innerHTML = `<div id=\"made\"></div>`\ndocument.getElementById('made')" }
    ])
    expect(p).toEqual([])
  })

  it('checks a whole folder and words the report for the model', async () => {
    write('js/utils.js', UTILS)
    write('js/app.js', APP)
    write('index.html', PAGE.replace('</body>', '<script src="js/gone.js"></script></body>'))
    write('node_modules/x/index.js', 'Utils.nothing()')
    const r = await checkReferences(ws)
    const text = referenceText(r)
    expect(text).toContain('Utils.showError')
    expect(text).toContain('js/gone.js')
    expect(text).toContain('file_outline')
    expect(text).not.toContain('node_modules')
    expect(referenceText({ files: 3, problems: [] })).toMatch(/Checked 3 source files/)
  })
})

describe('noticing the same failure again', () => {
  it('stays quiet the first time, speaks the second, and forgets after a success', () => {
    const t = new FailureTracker()
    const k = FailureTracker.key('edit_file', 'a.js', 'old_string not found (line 12)')
    expect(t.failed(k)).toBe('')
    expect(t.failed(FailureTracker.key('edit_file', 'a.js', 'old_string not found (line 99)'))).toContain('second time')
    expect(t.failed(k)).toContain('3th time')
    t.succeeded('edit_file|a.js|')
    expect(t.failed(k)).toBe('')
  })

  it('does not mix up different files', () => {
    const t = new FailureTracker()
    expect(t.failed(FailureTracker.key('edit_file', 'a.js', 'nope'))).toBe('')
    expect(t.failed(FailureTracker.key('edit_file', 'b.js', 'nope'))).toBe('')
  })
})

const plan3 = (extra?: Partial<ConversationPlan['steps'][number]>[]): ConversationPlan => {
  const r = applyPlanUpdate(undefined, {
    goal: 'G',
    design: 'D',
    steps: [
      { text: 'Write a.js', status: 'doing', verify: 'node --check a.js', ...extra?.[0] },
      { text: 'Write b.js', status: 'todo', ...extra?.[1] },
      { text: 'Write c.js', status: 'todo', ...extra?.[2] }
    ]
  })
  if ('error' in r) throw new Error(r.error)
  return r.plan
}

describe('plan steps with checks', () => {
  it('keeps a step\'s check when the plan is sent again without it', () => {
    const p = plan3()
    const next = applyPlanUpdate(p, { steps: [{ text: 'Write a.js', status: 'done' }, { text: 'Write b.js', status: 'doing' }, 'Write c.js'] })
    if ('error' in next) throw new Error(next.error)
    expect(next.plan.steps[0].verify).toBe('node --check a.js')
    expect(planText(next.plan, false)).toContain('1. [x] Write a.js (check: node --check a.js)')
  })

  it('lets the model replace or remove a check', () => {
    const p = plan3()
    const r = applyPlanUpdate(p, { steps: [{ text: 'Write a.js', verify: 'npm test' }, { text: 'Write b.js', verify: '' }] })
    if ('error' in r) throw new Error(r.error)
    expect(r.plan.steps[0].verify).toBe('npm test')
    expect(r.plan.steps[1].verify).toBeUndefined()
  })

  it('changes one step by number and says which are newly done', () => {
    const p = plan3()
    const r = withStepStatus(p, 1, 'done')
    if ('error' in r) throw new Error(r.error)
    expect(newlyDone(p, r.plan).map((s) => s.text)).toEqual(['Write a.js'])
    expect(newlyDone(r.plan, r.plan)).toEqual([])
    expect(withStepStatus(p, 9, 'done')).toEqual({ error: 'There is no step 9; the plan has 3 steps.' })
  })
})

describe('a step is done only when its check passes', () => {
  const step = (cmd: string): { plan: ConversationPlan; done: ConversationPlan['steps'] } => {
    const plan = plan3([{ verify: cmd }])
    const done = { ...plan, steps: plan.steps.map((s, i) => (i === 0 ? { ...s, status: 'done' as const } : s)) }
    return { plan: done, done: newlyDone(plan, done) }
  }

  it('marks the step verified when the command exits 0', async () => {
    const { plan, done } = step('node -e "process.exit(0)"')
    const out = await verifyDoneSteps(done, plan, makeCtx(ws))
    expect(out.steps[0]).toMatchObject({ status: 'done', verified: true })
    expect(planText(out, false)).toContain('✓ passed')
  })

  it('refuses, with the output, when the command fails', async () => {
    const { plan, done } = step('node -e "console.error(\'boom: test failed\'); process.exit(3)"')
    await expect(verifyDoneSteps(done, plan, makeCtx(ws))).rejects.toThrow(/NOT done[\s\S]*code 3[\s\S]*plan was not changed[\s\S]*boom: test failed/)
  })

  it('does nothing for a step without a check', async () => {
    const plan = plan3()
    const done = { ...plan, steps: plan.steps.map((s, i) => (i === 1 ? { ...s, status: 'done' as const } : s)) }
    const out = await verifyDoneSteps(newlyDone(plan, done), done, makeCtx(ws))
    expect(out.steps[1].verified).toBeUndefined()
  })

  it('update_plan keeps the plan as it was when the check fails, and set_step_status starts the next step on success', async () => {
    const tools = Object.fromEntries(planningTools().map((t) => [t.name, t]))
    let saved: ConversationPlan | undefined
    const ctx = makeCtx(ws)
    ctx.services.setPlan = (p) => {
      saved = p
      ctx.conversation.plan = p
    }
    ctx.conversation.plan = plan3([{ verify: 'node -e "process.exit(1)"' }])
    await expect(tools.set_step_status.execute({ step: 1, status: 'done' }, ctx)).rejects.toThrow(/NOT done/)
    expect(saved).toBeUndefined()
    expect(ctx.conversation.plan.steps[0].status).toBe('doing')

    ctx.conversation.plan = plan3([{ verify: 'node -e "process.exit(0)"' }])
    const ok = await tools.set_step_status.execute({ step: 1, status: 'done' }, ctx)
    expect(ok.content).toContain('Checks passed for: "Write a.js"')
    expect(saved!.steps.map((s) => s.status)).toEqual(['done', 'doing', 'todo'])
    await expect(tools.set_step_status.execute({ step: 7, status: 'done' }, ctx)).rejects.toThrow(/no step 7/)
  })
})

describe('a plan step\'s check needs the same permission as a command', () => {
  const tools = () => Object.fromEntries(planningTools().map((t) => [t.name, t]))

  it('asks before a finished step\'s command is run, unless commands run on their own', async () => {
    const ctx = makeCtx(ws)
    ctx.conversation.plan = plan3([{ verify: 'echo hi' }])
    const preview = await tools().set_step_status.describe!({ step: 1, status: 'done' }, ctx)
    expect(preview).toMatchObject({ kind: 'command', command: 'echo hi', forceApproval: true })
    const viaPlan = await tools().update_plan.describe!({ steps: [{ text: 'Write a.js', status: 'done' }] }, ctx)
    expect(viaPlan).toMatchObject({ kind: 'command', forceApproval: true })
    const open = makeCtx(ws, (s) => (s.agent.toolPermissions = { run_command: 'auto' }))
    open.conversation.plan = ctx.conversation.plan
    expect((await tools().set_step_status.describe!({ step: 1, status: 'done' }, open)).forceApproval).toBe(false)
  })

  it('asks about nothing when no check would run', async () => {
    const ctx = makeCtx(ws)
    ctx.conversation.plan = plan3()
    expect(await tools().set_step_status.describe!({ step: 2, status: 'done' }, ctx)).toEqual({ kind: 'generic', title: 'Update the plan' })
    expect(await tools().set_step_status.describe!({ step: 1, status: 'blocked' }, ctx)).toEqual({ kind: 'generic', title: 'Update the plan' })
    expect(await tools().update_plan.describe!({ goal: 'x', steps: ['a'] }, ctx)).toEqual({ kind: 'generic', title: 'Update the plan' })
  })
})

describe('the final check when every step is done', () => {
  it('reports broken references and that nothing was run', async () => {
    write('u.js', UTILS)
    write('app.js', 'Utils.nope()')
    const conv = makeCtx(ws).conversation
    const text = await finishReport(conv, ws)
    expect(text).toContain('Utils.nope')
    expect(text).toContain('NOTHING has been run')
  })

  it('is satisfied by a passing test command or a verified step, not by ls or a failed run', () => {
    const conv = makeCtx(ws).conversation
    const call = (id: string, command: string) => ({ id, name: 'run_command', arguments: JSON.stringify({ command }) })
    conv.messages.push(
      { id: 'm1', role: 'assistant', createdAt: 0, content: '', toolCalls: [call('c1', 'ls -la'), call('c2', 'npm test')] },
      { id: 'm2', role: 'tool', createdAt: 0, content: 'Exit code: 0', toolCallId: 'c1' }
    )
    expect(ranChecks(conv)).toBe(false)
    conv.messages.push({ id: 'm3', role: 'tool', createdAt: 0, content: 'Exit code: 1', toolCallId: 'c2', isError: true })
    expect(ranChecks(conv)).toBe(false)
    conv.messages.push({ id: 'm4', role: 'assistant', createdAt: 0, content: '', toolCalls: [call('c3', 'npx vitest run')] }, { id: 'm5', role: 'tool', createdAt: 0, content: 'Exit code: 0', toolCallId: 'c3' })
    expect(ranChecks(conv)).toBe(true)
    const verifiedPlan = plan3()
    verifiedPlan.steps[0] = { ...verifiedPlan.steps[0], status: 'done', verified: true }
    expect(ranChecks({ messages: [], plan: verifiedPlan })).toBe(true)
  })

  it('update_plan appends the final report only when the last step has just been finished', async () => {
    const tools = Object.fromEntries(planningTools().map((t) => [t.name, t]))
    const ctx = makeCtx(ws)
    ctx.services.setPlan = (p) => (ctx.conversation.plan = p)
    const first = await tools.update_plan.execute({ goal: 'G', steps: [{ text: 'a', status: 'doing' }, { text: 'b' }] }, ctx)
    expect(first.content).not.toContain('Final checks')
    const last = await tools.update_plan.execute({ steps: [{ text: 'a', status: 'done' }, { text: 'b', status: 'done' }] }, ctx)
    expect(last.content).toContain('All steps are done. Final checks')
    const again = await tools.update_plan.execute({ steps: [{ text: 'a', status: 'done' }, { text: 'b', status: 'done' }] }, ctx)
    expect(again.content).not.toContain('Final checks')
  })
})

describe('opening a page to see what breaks', () => {
  const clean: PageReport = { url: 'file:///x/index.html', title: 'Dynasty', errors: [], warnings: [], failedRequests: [], text: 'Find your league', clicks: [], expected: [] }

  it('says plainly when there are no errors, and shows what the page shows', () => {
    expect(pageHasProblems(clean)).toBe(false)
    const t = pageReportText(clean, 'index.html')
    expect(t).toContain('No errors in index.html.')
    expect(t).toContain('The page shows: "Find your league"')
  })

  it('lists console errors, failed files, missing buttons and elements', () => {
    const bad: PageReport = {
      ...clean,
      errors: ['Uncaught ReferenceError: API is not defined (js/app.js:12)'],
      failedRequests: ['net::ERR_FILE_NOT_FOUND: file:///x/js/missing.js'],
      clicks: [{ selector: '#go', found: false }, { selector: '#ok', found: true }],
      expected: [{ selector: '#tradeResult', found: false }],
      text: ''
    }
    expect(pageHasProblems(bad)).toBe(true)
    const t = pageReportText(bad, 'index.html')
    expect(t).toContain('4 problems in index.html')
    expect(t).toContain('API is not defined')
    expect(t).toContain('ERR_FILE_NOT_FOUND')
    expect(t).toContain('could not click "#go"')
    expect(t).toContain('expected an element matching "#tradeResult"')
    expect(t).toContain('the page body is empty')
  })

  it('run_page asks the browser service for the file and reports its answer as an error when something broke', async () => {
    write('index.html', '<html></html>')
    const tool = verifyTools().find((t) => t.name === 'run_page')!
    const ctx = makeCtx(ws)
    let asked: { url: string; click: string[] } | undefined
    ctx.services.runPage = async (url, opts) => {
      asked = { url, click: opts.click }
      return { ...clean, errors: ['Uncaught TypeError: x is not a function'] }
    }
    const preview = await tool.describe!({ path: 'index.html' }, ctx)
    expect(preview.title).toContain('index.html')
    const r = await tool.execute({ path: 'index.html', click: ['#a', 7, ' '] }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('x is not a function')
    expect(asked!.url).toMatch(/^file:\/\/.*index\.html$/)
    expect(asked!.click).toEqual(['#a'])
  })

  it('run_page refuses other sites, non-pages and a missing browser', async () => {
    const tool = verifyTools().find((t) => t.name === 'run_page')!
    const ctx = makeCtx(ws)
    expect(() => tool.describe!({ url: 'https://example.com/' }, ctx)).toThrow(/localhost/)
    expect(() => tool.describe!({ path: 'a.txt' }, ctx)).toThrow(/\.html/)
    expect(() => tool.describe!({}, ctx)).toThrow(/Give "path"/)
    expect(await tool.describe!({ url: 'http://localhost:5173/' }, ctx)).toMatchObject({ title: expect.stringContaining('localhost:5173') })
    await expect(tool.execute({ path: 'index.html' }, ctx)).rejects.toThrow(/not available/)
  })

  it('check_references runs on the workspace', async () => {
    write('u.js', UTILS)
    write('app.js', 'Utils.nope()')
    const tool = verifyTools().find((t) => t.name === 'check_references')!
    const r = await tool.execute({}, makeCtx(ws))
    expect(r.isError).toBe(true)
    expect(r.content).toContain('Utils.nope')
    await expect(tool.execute({}, makeCtx(null))).rejects.toThrow(/workspace/)
  })
})

describe('a page that comes back empty', () => {
  it('tells the model it is probably drawn by JavaScript and where to look instead', () => {
    const hint = emptyPageHint('', true, 200)
    expect(hint).toMatch(/drawn by JavaScript/)
    expect(hint).toMatch(/raw\.githubusercontent\.com/)
  })
  it('stays quiet for real pages, errors and non-pages', () => {
    expect(emptyPageHint('x'.repeat(300), true, 200)).toBe('')
    expect(emptyPageHint('', true, 404)).toBe('')
    expect(emptyPageHint('{"a":1}', false, 200)).toBe('')
  })
})
