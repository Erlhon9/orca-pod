// 실제 앱·브라우저·캡처 없이, Node 안의 DOM 모형과 가상 요청으로 사용자 흐름을 검증한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { WORK_JOURNAL_KEY, readWorkJournal, readWorkMemory } from './work-memory';
import { ProgressRepository } from './progress';
import { PriorityRepository } from './work-priority';
const panelCode = execFileSync('bun', ['build', 'src/panel/app.ts', '--target=browser'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const w = {
    id: 'example-work', workspaceId: 'example', name: 'Example task', branch: 'example', repoId: 'example-repo', repo: 'Example',
    path: '/fictional/example', status: 'in-progress', parentId: null, childIds: [], isMain: false, pinned: false, unread: false,
    activity: 'active', lastActivityAt: 20, liveTerminals: 0, terminals: [], topic: null, pr: null, comment: '',
    agents: [{ key: 'fictional-session', type: 'claude', state: 'waiting', title: 'Example session', prompt: 'Review the options.',
            lastMessage: 'The deployment is not verified.', tool: { name: 'AskUserQuestion', input: '{"questions":[{"question":"Choose an approach","options":[{"label":"Small change"}]}]}' },
            since: 10, updatedAt: 20, subagents: 0, surface: 'chat', terminal: null, interrupted: false }]
};
const snapshot = () => ({ at: 20, repos: [{ id: w.repoId, name: w.repo, topics: [], workspaceIds: [w.id] }], workspaces: { [w.id]: structuredClone(w) }, statuses: ['in-progress'] });
const wait = async (predicate) => {
    for (let i = 0; i < 100; i++) {
        if (predicate())
            return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Fictional DOM update timed out');
};
async function fixture(lang = 'en', initial = {}, initialSnapshot = snapshot()) {
    const window = new Window({ url: 'https://pod-fixture.invalid', settings: { enableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
    window.document.body.innerHTML = '<div id="app"></div>';
    window.localStorage.setItem('pod.lang', lang);
    // 자동 폴링을 돌리지 않고 테스트가 명시적으로 새 스냅샷을 전달한다.
    window.setInterval = (() => 0);
    window.HTMLCanvasElement.prototype.getContext = () => ({ measureText: text => ({ width: String(text).length * 6.5 }) });
    const events = new Map();
    const stored = structuredClone(initial);
    const progress=new ProgressRepository({get:async key=>structuredClone(stored[key]),set:async(key,value)=>{if(failSave)throw new Error('fictional storage failure');stored[key]=structuredClone(value)}});
    const calls = [];
    const priorities=new PriorityRepository({get:async key=>structuredClone(stored[key]),set:async(key,value)=>{if(failSave)throw new Error("fictional failure");stored[key]=structuredClone(value)}});
    let failSave = false;
    let failTopicApply = false;
    let releaseAgents;
    let pendingSend;
    let holdSend = false;
    let rejectSend;
    const controlView = {provider:'claude',items:[],live:'',busy:false,since:0,sessionId:null,error:null,turns:initial['pod.control-turns.v1'] || [],watch:initial['mock-watch'] || {settings:{intervalMinutes:0,changes:false,scopeMode:'all'},notes:[],error:null,saving:false}};
    let snap = structuredClone(initialSnapshot);
    window.orca = {
        storage: {
            get: async (key) => structuredClone(stored[key]),
            set: async (key, value) => { if (failSave)
                throw new Error('fictional storage failure'); stored[key] = structuredClone(value); }
        },
        plugin: {
            on: (name, listener) => events.set(name, listener),
            request: async (name, input) => {
                calls.push({ name, input });
                if (name === 'pod.snapshot') {
                    try {if(await progress.observe(snap))events.get('pod.progress.changed')?.({});}catch{}
                    return structuredClone(snap);
                }
                if(name==='pod.priority.view')return priorities.view();
                if(name==='pod.priority.set'){const result=await priorities.set(input,snap);events.get('pod.priority.changed')?.({});return result;}
                if (name === 'pod.progress.view') return progress.view(input);
                if (name === 'pod.progress.change') {await progress.change(input);events.get('pod.progress.changed')?.({});return {saved:true};}
                if (name === 'pod.control.agents')
                    return new Promise(resolve => { releaseAgents = resolve; });
                if (name === 'pod.control.view')
                    return structuredClone(controlView);
                if (name === 'pod.control.send' && holdSend) return new Promise((resolve,reject) => {pendingSend=resolve;rejectSend=reject;});
                if (name === 'pod.applyTopicPlan') { if (failTopicApply) throw new Error('stale topic plan'); return {assigned:input.plan.assignments.length}; }
                if (name === 'pod.control.briefing') return structuredClone(initial['mock-briefing'] || null);
                if (name === 'pod.control.watch.check') return {started:false,reason:'skip'};
                if (name === 'pod.control.watch.configure') { controlView.watch.settings=structuredClone(input);return structuredClone(input); }
                if (name === 'pod.language')
                    return { default: 'en', preference: lang };
                if (name === 'pod.conversation')
                    return { ok: true, items: [{ k: 'text', at: 20, text: 'Fictional conversation body' }], truncated: false, updatedAt: 20 };
                return { ok: true, terminal: null };
            }
        },
        shell: { openExternal: () => { throw new Error('External navigation is forbidden in this fixture'); } }
    };
    window.eval(panelCode);
    await wait(() => !!window.document.querySelector('.graph-wrap, .repo'));
    return {
        window, document: window.document, stored, calls,
        emit: (next) => { snap = next; events.get('pod.changed')?.(structuredClone(next));void progress.observe(next).then(changed=>{if(changed)events.get('pod.progress.changed')?.({});}).catch(()=>{}); },
        progress,
        control: (next) => events.get('pod.control.view')?.({...controlView,...next}),
        deferSend: () => {holdSend=true;},
        finishSend: (error) => error ? rejectSend?.(error) : pendingSend?.({sent:true}),
        failTopicApply: (value) => { failTopicApply=value; },
        fail: (value) => { failSave = value; },
        agents: (value) => releaseAgents?.(value),
        close: async () => { await window.happyDOM.abort(); window.close(); }
    };
}
function openLegacyOverview(f) {
    f.document.querySelector('.gc').dispatchEvent(new f.window.MouseEvent('contextmenu', {bubbles:true,cancelable:true}));
    const button=[...f.document.querySelectorAll('.menu .mi')].find(b => b.textContent === (f.window.localStorage.getItem('pod.lang')==='ko'?'작업 맥락':'Context'));
    assert.ok(button, 'explicit saved-context menu exists');
    button.click();
}
test('그래프 → 맥락 → 원문 흐름과 명시 확인은 실제 전송·승인을 실행하지 않는다', async () => {
    const f = await fixture();
    try {
        assert.equal(f.document.querySelector('.gc')?.dataset.attn, 'waiting');
        openLegacyOverview(f);
        await wait(() => !!f.document.querySelector('.work-brief'));
        assert.equal(!!f.document.querySelector('.detail.inline'), true);
        assert.equal(f.document.querySelector('.s-head')?.hasAttribute('hidden'), true);
        const context = f.document.querySelector('details');
        context.setAttribute('open', '');
        assert.equal(context.textContent.includes('The deployment is not verified.'), true);
        assert.equal(context.textContent.includes('Latest reply · excerpt'), true);
        assert.equal(f.calls.some(c => c.name === 'pod.conversation'), false);
        f.document.querySelector('.brief-review button').click();
        await wait(() => !!f.stored[WORK_JOURNAL_KEY]?.[w.id]?.reviewed);
        assert.equal(f.document.querySelector('.brief-status')?.textContent, 'Question waiting');
        assert.equal(f.calls.some(c => /send|interrupt|markRead|setStatus/.test(c.name)), false);
        f.document.querySelector('.brief-context-body button').click();
        await wait(() => !!f.document.querySelector('.convo'));
        assert.equal(f.document.querySelector('.s-head')?.hasAttribute('hidden'), false);
        assert.equal(f.calls.some(c => c.name === 'pod.conversation' && c.input.key === w.agents[0].key), true);
        const conversation = f.document.querySelector('.convo');
        const next = snapshot();
        next.workspaces[w.id].agents[0].updatedAt = 500;
        f.emit(next);
        assert.equal(f.document.querySelector('.convo'), conversation);
    }
    finally {
        await f.close();
    }
});
test('브리프는 저장 후 재열어도 남고 같은 메타데이터 폴링은 카드·펼친 맥락을 유지한다', async () => {
    const f = await fixture();
    try {
        ;
        openLegacyOverview(f);
        f.document.querySelector('.brief-toolbar button').click();
        const fields = [...f.document.querySelectorAll('form textarea')];
        assert.equal(fields.length, 4);
        fields[0].value = 'Fix the example safely';
        fields[1].value = 'Review and regression tests';
        fields[2].value = 'Check the failing condition';
        fields[3].value = 'Keep existing behavior';
        f.document.querySelector('form button[type=submit]').click();
        await wait(() => !!f.stored[WORK_JOURNAL_KEY]?.[w.id]?.goal);
        const context = f.document.querySelector('details');
        context.setAttribute('open', '');
        const card = f.document.querySelector('.gc');
        const next = snapshot();
        next.at = 500;
        next.workspaces[w.id].lastActivityAt = 500;
        next.workspaces[w.id].agents[0].since = 499;
        next.workspaces[w.id].agents[0].updatedAt = 500;
        f.emit(next);
        assert.equal(f.document.querySelector('.gc'), card);
        assert.equal(f.document.querySelector('details'), context);
        assert.equal(f.document.querySelector('details')?.hasAttribute('open'), true);
        next.workspaces[w.id].agents[0].lastMessage = 'A new finding. Still unverified.';
        f.emit(next);
        assert.equal(f.document.querySelector('details')?.hasAttribute('open'), true);
        assert.equal(f.document.querySelector('details')?.textContent.includes('A new finding.'), true);
        const other = await fixture('en', f.stored);
        try {
            assert.equal(other.document.querySelector('.gc-recap')?.textContent, 'Fix the example safely');
            openLegacyOverview(other);
            assert.equal(other.document.querySelector('.work-brief')?.textContent.includes('Keep existing behavior'), true);
        }
        finally {
            await other.close();
        }
    }
    finally {
        await f.close();
    }
});
test('저장 실패는 입력 폼을 닫거나 성공 표시하지 않고 재시도할 수 있다', async () => {
    const f = await fixture();
    try {
        ;
        openLegacyOverview(f);
        f.document.querySelector('.brief-toolbar button').click();
        const goal = f.document.querySelector('form textarea');
        goal.value = 'Do not lose this draft';
        f.fail(true);
        f.document.querySelector('form button[type=submit]').click();
        await wait(() => !!f.document.querySelector('.toast.err'));
        assert.equal(!!f.document.querySelector('form'), true);
        assert.equal(goal.value, 'Do not lose this draft');
        assert.equal(f.stored[WORK_JOURNAL_KEY], undefined);
        f.fail(false);
        f.document.querySelector('form button[type=submit]').click();
        await wait(() => !!f.stored[WORK_JOURNAL_KEY]?.[w.id]?.goal);
        assert.equal(readWorkJournal(f.stored[WORK_JOURNAL_KEY])[w.id].goal, goal.value);
    }
    finally {
        await f.close();
    }
});
test('역할 강제 없이 공급자를 선택하고 감지 목록이 늦게 와도 선택을 덮어쓰지 않는다', async () => {
    const f = await fixture();
    try {
        ;
        openLegacyOverview(f);
        f.document.querySelectorAll('.brief-toolbar button')[1].click();
        const select = f.document.querySelector('form select');
        assert.equal([...select.options].some((o) => o.value === 'gemini'), true);
        select.value = 'gemini';
        f.agents([{ id: 'codex', label: 'Codex', mode: 'embedded', detected: true }]);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(select.value, 'gemini');
        f.document.querySelector('form button[type=submit]').click();
        await wait(() => f.calls.some(c => c.name === 'pod.launchAgent'));
        const launch = f.calls.find(c => c.name === 'pod.launchAgent');
        assert.equal(launch.input.agent, 'gemini');
        assert.equal(launch.input.id, w.id);
    }
    finally {
        await f.close();
    }
});
test('한국어 맥락과 특수문자 메모를 안전한 텍스트로 표시한다', async () => {
    const f = await fixture('ko', { [WORK_JOURNAL_KEY]: { [w.id]: readWorkMemory({ goal: '<img src=x onerror=alert(1)>', note: '<script>not code</script>' }) } });
    try {
        assert.equal(f.document.querySelector('.toolbar [aria-selected=true]')?.textContent, '그래프');
        openLegacyOverview(f);
        assert.equal(f.document.querySelector('.work-brief')?.textContent.includes('<script>not code</script>'), true);
        assert.equal(f.document.querySelectorAll('.work-brief script, .work-brief img').length, 0);
        assert.equal(f.document.querySelector('.brief-context-heading')?.textContent.includes('맥락 자세히 보기'), true);
    }
    finally {
        await f.close();
    }
});

test('기존 보드 선택을 유지하고 저장한 목표·메모로도 작업을 검색한다', async () => {
    const existing = await fixture('en', { 'pod.prefs': { view: 'board', repo: w.repoId, lang: 'en' } });
    try {
        assert.equal(existing.document.querySelector('.toolbar [aria-selected=true]')?.textContent, 'Board');
        assert.equal(existing.document.querySelector('.graph-wrap'), null);
    } finally { await existing.close(); }
    const f = await fixture('en', { [WORK_JOURNAL_KEY]: { [w.id]: readWorkMemory({ goal: 'Improve the compass', note: 'Keep the amber marker' }) } });
    try {
        const input = f.document.querySelector('.search input');
        input.value = 'amber marker';
        input.dispatchEvent(new f.window.Event('input'));
        assert.equal(f.document.querySelectorAll('.gc').length, 1);
        input.value = 'unrelated search';
        input.dispatchEvent(new f.window.Event('input'));
        assert.equal(f.document.querySelectorAll('.gc').length, 0);
        assert.equal(f.document.querySelectorAll('.g-ws').length, 0);
    } finally { await f.close(); }
});

test('퀘스트 설정은 그래프로 옮기고 저장한 배치·기억은 보존한다', async () => {
    const positions = { '["topic","example-repo","example-work"]': { x: 45, y: -90 } };
    const f = await fixture('en', { 'pod.prefs': { view: 'quests', repo: w.repoId, lang: 'en', graphPositions: positions }, [WORK_JOURNAL_KEY]: { [w.id]: readWorkMemory({ goal: 'Keep this objective', nextStep: 'Inspect the next condition' }) } });
    try {
        assert.equal(f.document.querySelector('.toolbar [aria-selected=true]')?.textContent, 'Graph');
        assert.equal(f.document.querySelectorAll('.toolbar [role=tab]').length, 3);
        assert.equal(f.document.querySelector('.gc-recap')?.textContent, 'Keep this objective');
        assert.equal(f.document.querySelector('.gc-next')?.textContent, 'Inspect the next condition');
        assert.deepEqual(f.stored['pod.prefs'].graphPositions, positions);
        openLegacyOverview(f);
        assert.equal(!!f.document.querySelector('.detail.inline.context-mode'), true);
        assert.equal(!!f.document.querySelector('.graph-wrap'), true);
        assert.equal(f.document.querySelector('.brief-emblem'), null);
    } finally { await f.close(); }
});

test('확인 필요 탐색은 접힌 카드로 이동하고 위치나 실제 세션을 변경하지 않는다', async () => {
    const f = await fixture('en', { 'pod.prefs': { view: 'graph', lang: 'en', repo: w.repoId, graphSections: { 'example-repo:s:in-progress': 'closed' } } });
    try {
        assert.equal(f.document.querySelectorAll('.gc').length, 0);
        const next = f.document.querySelector('.g-attention');
        assert.equal(next.textContent, 'Needs you 1');
        next.click();
        assert.equal(f.document.querySelectorAll('.gc').length, 1);
        assert.equal(!!f.document.querySelector('.g-ws.selected'), true);
        assert.equal(f.calls.some(call => /focusAgent|launchAgent|send|setStatus/.test(call.name)), false);
        assert.equal(f.stored['pod.prefs'].graphPositions && Object.keys(f.stored['pod.prefs'].graphPositions).length, 0);
    } finally { await f.close(); }
});

test('맥락을 접고 펼쳐도 본문·스크롤·펼친 출처를 유지하고 폴링이 접기를 해제하지 않는다', async () => {
    const f = await fixture();
    try {
        openLegacyOverview(f);
        const box = f.document.querySelector('.work-brief');
        const context = box.querySelector('details');
        context.setAttribute('open', '');
        box.scrollTop = 80;
        f.document.querySelector('.d-minimize').click();
        assert.equal(f.document.querySelector('.detail')?.classList.contains('minimized'), true);
        assert.equal(f.document.querySelector('.d-minimize')?.getAttribute('aria-expanded'), 'false');
        const next = snapshot();
        next.workspaces[w.id].agents[0].updatedAt = 100;
        f.emit(next);
        assert.equal(f.document.querySelector('.detail')?.classList.contains('minimized'), true);
        f.document.querySelector('.d-minimize').click();
        assert.equal(f.document.querySelector('.detail')?.classList.contains('minimized'), false);
        assert.equal(f.document.querySelector('.work-brief'), box);
        assert.equal(box.scrollTop, 80);
        assert.equal(context.hasAttribute('open'), true);
        assert.equal(f.calls.some(call => /focusAgent|launchAgent|send|setStatus/.test(call.name)), false);
    } finally { await f.close(); }
});


test('작업·세션 선택은 관제의 범위를 바꾸며 원문·전송·새 에이전트를 자동 실행하지 않는다', async () => {
    const f=await fixture();
    try {
        f.document.querySelector('.gc-head').click();
        assert.equal(f.document.querySelector('.detail'),null);
        assert.ok(f.document.querySelector('.control.open'));
        assert.ok(f.document.querySelector('.dk-target').textContent.includes(w.name));
        assert.ok(f.document.querySelector('.dk-context-question').textContent.includes('Choose an approach'));
        f.document.querySelector('.gc-sess').click();
        assert.ok(f.document.querySelector('.dk-target').textContent.includes('Example session'));
        assert.ok(f.document.querySelector('.g-ws.selected'));
        assert.equal(f.calls.some(c=>/send|conversation|launchAgent|focusAgent|setStatus/.test(c.name)),false);
        f.document.querySelector('.dk-source').click();
        await wait(()=>f.calls.some(c=>c.name==='pod.conversation'));
        assert.ok(f.document.querySelector('.dk-target').textContent.includes('Example session'));
    } finally {await f.close();}
});

test('대상별 초안과 전송 중 범위를 보존하고 늦은 답변이 현재 선택을 바꾸지 않는다', async () => {
    const f=await fixture();
    try {
        const next=snapshot();
        const other=structuredClone(w);other.id='other-work';other.name='Other task';other.agents[0].key='other-session';
        next.workspaces[other.id]=other;next.repos[0].workspaceIds.push(other.id);f.emit(next);
        const select=id=>f.document.querySelector('[data-work="'+id+'"] .gc-head').click();
        const input=()=>f.document.querySelector('.dk-composer textarea');
        select(w.id);input().value='Draft for A';input().dispatchEvent(new f.window.Event('input'));
        select(other.id);assert.equal(input().value,'');
        input().value='Draft for B';input().dispatchEvent(new f.window.Event('input'));
        select(w.id);assert.equal(input().value,'Draft for A');
        f.deferSend();f.document.querySelector('.dk-composer .send').click();
        await wait(()=>f.calls.some(c=>c.name==='pod.control.send'));
        const sent=f.calls.find(c=>c.name==='pod.control.send').input;
        select(other.id);assert.equal(input().value,'Draft for B');
        assert.equal(sent.scope.targets[0].workspaceId,w.id);
        assert.ok(sent.text.endsWith('Draft for A'));
        f.finishSend();await new Promise(resolve=>setTimeout(resolve,0));
        assert.equal(input().value,'Draft for B');
        f.control({rev:3,items:[{k:'user',text:sent.text,at:1,images:0,requestId:'a-request'},{k:'text',text:'A reply',at:2,requestId:'a-request'}],turns:[{id:'a-request',label:'Example / A work',displayText:'Draft for A',text:sent.text,status:'complete'}]});
        assert.ok(f.document.querySelector('.dk-target').textContent.includes(other.name));
        assert.ok(f.document.querySelector('.chat-scope').textContent.includes('A work'));
        assert.equal(f.document.querySelector('.bubble-me').textContent,'Draft for A');
        assert.equal(input().value,'Draft for B');
    } finally {await f.close();}
});

test('실패한 전송은 원래 초안을 남기고 사라진 세션을 다른 대상에게 보내지 않는다', async () => {
    const f=await fixture();
    try {
        f.document.querySelector('.gc-sess').click();
        const input=f.document.querySelector('.dk-composer textarea');
        input.value='Keep this message';input.dispatchEvent(new f.window.Event('input'));
        f.deferSend();f.document.querySelector('.dk-composer .send').click();
        await wait(()=>f.calls.some(c=>c.name==='pod.control.send'));
        f.finishSend(new Error('fixture failure'));await new Promise(resolve=>setTimeout(resolve,0));
        assert.equal(input.value,'Keep this message');
        const next=snapshot();next.workspaces[w.id].agents=[];f.emit(next);
        const before=f.calls.filter(c=>c.name==='pod.control.send').length;
        f.document.querySelector('.dk-composer .send').click();await new Promise(resolve=>setTimeout(resolve,0));
        assert.equal(f.calls.filter(c=>c.name==='pod.control.send').length,before);
        assert.equal(input.value,'Keep this message');
    } finally {await f.close();}
});

test('브리핑 요청은 명시 클릭으로만 시작하고 별도 보관된 브리핑은 재열기와 변경 감지에 사용한다', async () => {
    const f=await fixture();
    try {
        f.document.querySelector('.gc-head').click();
        assert.equal(f.calls.some(c=>c.name==='pod.control.send'),false);
        f.document.querySelector('.dk-request-brief').click();
        await wait(()=>f.calls.some(c=>c.name==='pod.control.send'));
        const sent=f.calls.find(c=>c.name==='pod.control.send').input;
        assert.equal(sent.scope.kind,'briefing');
        assert.equal(sent.scope.targets[0].workspaceId,w.id);
        assert.equal(sent.scope.displayText,'Prepare a briefing for this work');
        const saved={id:'saved-brief',provider:'claude',targets:sent.scope.targets,label:'Example task',text:sent.text,displayText:'Brief',kind:'briefing',startedAt:1,endedAt:2,status:'complete',answer:'Goal: review the choices. Next: choose the small change.',sourceVersion:sent.scope.sourceVersion};
        const other=await fixture('en',{'pod.control-turns.v1':[saved]});
        try {
            other.document.querySelector('.gc-head').click();
            assert.ok(other.document.querySelector('.dk-briefing').textContent.includes('choose the small change'));
            assert.equal(other.calls.some(c=>c.name==='pod.control.send'),false);
            const next=snapshot();next.workspaces[w.id].comment='New decision';other.emit(next);
            assert.ok(other.document.querySelector('.dk-context').textContent.includes('Changes since'));
        }finally{await other.close();}
    } finally {await f.close();}
});

test('최근 관제 이력이 비어도 작업별 보관 브리핑을 조회하며 새 모델 요청을 실행하지 않는다', async () => {
    const targets=[{workspaceId:w.id,sessionKey:null}];
    const saved={id:'independent-cache',provider:'claude',targets,label:'Example task',text:'Read',displayText:'Brief',kind:'briefing',startedAt:1,endedAt:2,status:'complete',answer:'The durable decision remains available.',sourceVersion:'old'};
    const f=await fixture('en',{'mock-briefing':saved});
    try {
        f.document.querySelector('.gc-head').click();
        await wait(()=>f.document.querySelector('.dk-briefing')?.textContent.includes('durable decision'));
        assert.equal(f.calls.some(c=>c.name==='pod.control.send'),false);
        const context=f.document.querySelector('.dk-context');
        context.querySelector('details').open=true;context.scrollTop=60;
        f.document.querySelector('.dk-fold').click();
        const next=snapshot();next.workspaces[w.id].agents[0].updatedAt=99;f.emit(next);
        assert.equal(f.document.querySelector('.control').classList.contains('open'),false);
        f.document.querySelector('.dk-fold').click();
        assert.equal(f.document.querySelector('.dk-context details').open,true);
        assert.equal(context.scrollTop,60);
    } finally {await f.close();}
});

test('관제 전체 읽기에서 원문을 열면 지도 영역을 복원하고 현재 대상을 유지한다', async () => {
    const f=await fixture();
    try {
        f.document.querySelector('.gc-sess').click();
        f.document.querySelector('.dk-read').click();
        assert.ok(f.document.querySelector('.workspace-shell.control-full'));
        f.document.querySelector('.dk-source').click();
        await wait(()=>!!f.document.querySelector('.detail'));
        assert.equal(f.document.querySelector('.workspace-shell.control-full'),null);
        assert.ok(f.document.querySelector('.dk-target').textContent.includes('Example session'));
        assert.equal(f.calls.some(c=>/control.send|launchAgent/.test(c.name)),false);
    } finally {await f.close();}
});

test('빈 관제는 설명과 대화 영역을 비우고 실제 응답이 시작되면 대화를 표시한다', async () => {
    const f=await fixture('ko');
    try {
        f.document.querySelector('.dk-fold').click();
        const control=f.document.querySelector('.control');
        assert.equal(control.dataset.empty,'true');
        assert.equal(f.document.querySelector('.dk-chat .convo-inner').childElementCount,0);
        assert.equal(f.document.querySelector('.dk-context').childElementCount,0);
        assert.equal(control.textContent.includes('입력하세요.'),false);
        f.control({busy:true,since:1,rev:1});
        assert.equal(control.dataset.empty,'false');
        assert.ok(f.document.querySelector('.dk-chat .chat-working'));
        f.control({busy:false,rev:2,items:[{k:'text',text:'실제 응답 내용',at:2}]});
        assert.equal(control.dataset.empty,'false');
        assert.ok(f.document.querySelector('.dk-chat .msg-agent').textContent.includes('실제 응답 내용'));
        f.document.querySelector('.dk-fold').click();
        f.control({busy:false,rev:3,items:[]});
        assert.equal(f.document.querySelector('.dk-preview').childElementCount,0);
    } finally {await f.close();}
});


test('관제 주제 정리는 선택한 프로젝트와 에이전트로 제안만 요청하고 작성 중 초안을 보존한다', async () => {
    const f=await fixture();
    try {
        f.document.querySelector('.gc-head').click();
        const input=f.document.querySelector('.dk-composer textarea');
        input.value='Keep this draft';input.dispatchEvent(new f.window.Event('input'));
        assert.equal(f.document.querySelector('.control .dk-organize'),null);
        f.document.querySelector('.scope-topic-menu').click();
        assert.equal(f.calls.some(c=>c.name==='pod.control.send'),false);
        [...f.document.querySelectorAll('.menu .mi')].find(el=>el.textContent==='Suggest classification').click();
        await wait(()=>f.calls.some(c=>c.name==='pod.control.send'));
        const sent=f.calls.find(c=>c.name==='pod.control.send');
        assert.equal(sent.input.scope.kind,'topics');
        assert.equal(sent.input.scope.repoId,w.repoId);
        assert.equal(input.value,'Keep this draft');
        assert.equal(f.calls.some(c=>c.name==='pod.applyTopicPlan'||c.name==='pod.suggestTopics'),false);
        assert.equal(f.calls.some(c=>c.name==='pod.launchAgent'),false);
        const turn={id:'topics-1',provider:'claude',targets:[],label:'Example',displayText:'Organize topics',kind:'topics',status:'running'};
        f.document.querySelector('.dk-fold').click();
        f.control({busy:true,requestId:turn.id,rev:2,turns:[turn],live:'{"topics":[{"id":"private-json"'});
        assert.equal(f.document.querySelector('.dk-preview').textContent.includes('private-json'),false);
        assert.ok(f.document.querySelector('.dk-preview').textContent.includes('Organizing topics'));
        f.control({busy:false,requestId:turn.id,rev:3,turns:[{...turn,status:'complete'}],items:[{k:'text',text:'{"topics":[]}',at:3,requestId:turn.id}]});
        assert.equal(f.document.querySelector('.dk-preview').textContent,'The topic plan is ready.');
        f.control({provider:'gemini',rev:4});
        f.document.querySelector('.scope-topic-menu').click();
        const disabled=[...f.document.querySelectorAll('.menu .mi')].find(el=>el.textContent==='Suggest classification');
        assert.equal(disabled.disabled,true);
        assert.equal(f.document.activeElement.textContent,'Edit topics');
        const count=f.calls.filter(c=>c.name==='pod.control.send').length;disabled.click();
        assert.equal(f.calls.filter(c=>c.name==='pod.control.send').length,count);
    } finally {await f.close();}
});

test('지금 브리핑은 질문 입력 없이 현재 범위로 요청하고 초안과 선택을 바꾸지 않는다', async () => {
    const f=await fixture('ko');
    try {
        f.document.querySelector('.gc-head').click();
        const input=f.document.querySelector('.dk-composer textarea');input.value='작성 중인 내용';input.dispatchEvent(new f.window.Event('input'));
        const target=f.document.querySelector('.dk-target').dataset.targetKey;
        f.document.querySelector('.dk-brief-now').click();
        await wait(()=>f.calls.some(call=>call.name==='pod.control.watch.check'));
        const call=f.calls.find(call=>call.name==='pod.control.watch.check');
        assert.equal(call.input.manual,true);
        assert.equal(call.input.scope.repoId,w.repoId);
        assert.equal(input.value,'작성 중인 내용');
        assert.equal(f.document.querySelector('.dk-target').dataset.targetKey,target);
        assert.equal(f.calls.some(call=>call.name==='pod.control.send'||call.name==='pod.launchAgent'),false);
    } finally {await f.close();}
});

test('관제의 먼저 온 브리핑은 사용자 질문 없이 보이고 대화 기록이 없어도 복원된다', async () => {
    const note={id:'auto-note',scopeKey:'[null,null]',label:'전체 작업',answer:'지금 확인할 결과와 그 이유',at:10,fingerprint:'v1',workspaceIds:[w.id]};
    const watch={settings:{intervalMinutes:0,changes:false,scopeMode:'all'},notes:[note],error:null,saving:false};
    const f=await fixture('ko',{'mock-watch':watch});
    try {
        assert.ok(f.document.querySelector('.dk-preview').textContent.includes(note.answer));
        f.document.querySelector('.dk-fold').click();
        assert.equal(f.document.querySelectorAll('.dk-chat .msg-user').length,0);
        assert.ok(f.document.querySelector('.dk-chat').textContent.includes(note.answer));
        f.control({watch,items:[{k:'user',text:'내부 자동 브리핑 입력',at:9,requestId:note.id,controlKind:'watch'}],turns:[],rev:4});
        assert.equal(f.document.querySelectorAll('.dk-chat .msg-user').length,0);
        assert.equal([...f.document.querySelectorAll('.dk-chat .msg-agent')].filter(el=>el.textContent.includes(note.answer)).length,1);
    } finally {await f.close();}
});

test('브리핑 주기와 변화 알림·자동 범위를 사용자가 설정할 수 있다', async () => {
    const f=await fixture('ko');
    try {
        f.document.querySelector('.dk-more').click();
        [...f.document.querySelectorAll('.menu .mi')].find(el=>el.textContent==='브리핑 설정').click();
        const [periodic,changes]=f.document.querySelectorAll('form input[type=checkbox]');
        periodic.checked=true;periodic.dispatchEvent(new f.window.Event('change'));
        const minutes=f.document.querySelector('form input[type=number]');minutes.value='5';changes.checked=true;
        f.document.querySelector('form select').value='all';
        f.document.querySelector('form button[type=submit]').click();
        await wait(()=>f.calls.some(call=>call.name==='pod.control.watch.configure'));
        const call=f.calls.find(call=>call.name==='pod.control.watch.configure');
        assert.deepEqual(structuredClone(call.input),{intervalMinutes:5,changes:true,scopeMode:'all'});
        await wait(()=>f.calls.some(call=>call.name==='pod.control.watch.check'));
        assert.deepEqual(structuredClone(f.calls.find(call=>call.name==='pod.control.watch.check').input.scope),{repoId:null,topicKey:null});
    } finally {await f.close();}
});

test('관제 새 대화는 플러스 대신 메뉴에서 명시적으로 선택하며 응답 중에는 실행하지 않는다', async () => {
    const f=await fixture('ko');
    try {
        f.control({rev:2,items:[{k:'text',text:'이전 대화',at:1}]});
        assert.equal(f.document.querySelector('.dk-new'),null);
        f.document.querySelector('.dk-more').click();
        assert.equal(f.calls.some(c=>c.name==='pod.control.reset'),false);
        [...f.document.querySelectorAll('.menu .mi')].find(el=>el.textContent==='새 대화').click();
        assert.equal(f.calls.filter(c=>c.name==='pod.control.reset').length,1);
        f.control({busy:true,rev:3,items:[{k:'text',text:'진행 중',at:2}]});
        f.document.querySelector('.dk-more').click();
        const action=[...f.document.querySelectorAll('.menu .mi')].find(el=>el.textContent==='새 대화');
        assert.equal(action.disabled,true);action.click();
        assert.equal(f.calls.filter(c=>c.name==='pod.control.reset').length,1);
    } finally {await f.close();}
});

test('관제 위치 선택은 접기·보기 변경·새 응답·재열기에도 유지하고 초안과 대상을 보존한다', async () => {
    const f=await fixture('ko');
    try {
        const shell=f.document.querySelector('.workspace-shell');
        const style=f.document.createElement('style');style.textContent=readFileSync('src/panel/style.css','utf8');f.document.head.append(style);
        const areas=()=>f.window.getComputedStyle(shell).getPropertyValue('grid-template-areas');
        assert.equal(shell.dataset.controlDock,'bottom');
        f.document.querySelector('.gc-head').click();
        const input=f.document.querySelector('.dk-composer textarea');
        input.value='작성 중인 질문';input.dispatchEvent(new f.window.Event('input'));
        const target=f.document.querySelector('.dk-target').dataset.targetKey;
        const choose=(label)=>{
            f.document.querySelector('.dk-position').click();
            const option=[...f.document.querySelectorAll('.menu .mi')].find(el=>el.textContent===label);
            assert.ok(option,label);option.click();
        };
        choose('오른쪽');
        assert.equal(shell.dataset.controlDock,'right');
        assert.ok(areas().includes('body control'));
        f.document.querySelector('.dk-fold').click();
        assert.equal(shell.dataset.controlDock,'right');
        f.document.querySelector('.dk-fold').click();
        f.control({rev:6,items:[{k:'text',text:'응답 내용',at:10}]});
        assert.equal(shell.dataset.controlDock,'right');
        assert.equal(f.document.querySelector('.dk-position').textContent,'');
        assert.ok(f.document.querySelector('.dk-position').getAttribute('aria-label').includes('오른쪽'));
        for (const button of f.document.querySelectorAll('.dk-actions > button')) {
            assert.ok(button.getAttribute('aria-label'));
            assert.ok(button.querySelector('svg')?.childElementCount>0,'관제 도구 버튼의 아이콘이 비어 있으면 안 됨');
        }
        assert.equal(f.document.querySelector('.dk-composer textarea'),input);
        assert.equal(input.value,'작성 중인 질문');
        assert.equal(f.document.querySelector('.dk-target').dataset.targetKey,target);
        [...f.document.querySelectorAll('.toolbar .seg button')].find(el=>el.textContent==='보드').click();
        assert.equal(shell.dataset.controlDock,'right');
        choose('왼쪽');assert.equal(shell.dataset.controlDock,'left');assert.ok(areas().includes('control body'));
        choose('아래쪽');assert.equal(shell.dataset.controlDock,'bottom');assert.equal(areas().replaceAll('"','').replaceAll("'",'').trim(),'body control');
        const expandIcon=f.document.querySelector('.dk-read svg').innerHTML;
        f.document.querySelector('.dk-read').click();
        assert.equal(f.document.querySelector('.dk-read').getAttribute('aria-pressed'),'true');
        assert.notEqual(f.document.querySelector('.dk-read svg').innerHTML,expandIcon);
        assert.equal(areas().replaceAll('"','').replaceAll("'",'').trim(),'control');
        f.document.querySelector('.dk-read').click();
        assert.equal(f.document.querySelector('.dk-read').getAttribute('aria-pressed'),'false');
        choose('오른쪽');
        assert.equal(f.stored['pod.prefs'].controlPosition,'right');
        const reopened=await fixture('ko',f.stored);
        try {
            assert.equal(reopened.document.querySelector('.workspace-shell').dataset.controlDock,'right');
            assert.ok(reopened.document.querySelector('.dk-position').getAttribute('aria-label').includes('오른쪽'));
        } finally {await reopened.close();}
        choose('자동');
        assert.equal(shell.dataset.controlPosition,'auto');
        assert.equal(f.calls.some(c=>/control.send|launchAgent|control.reset/.test(c.name)),false);
    } finally {await f.close();}
});

test('상단 주제 탐색은 레포를 가로질러 하위 주제로 좁히며 모든 보기와 재열기에 유지된다', async () => {
    const snap=snapshot();
    snap.repos[0].topics=[{id:'dev-a',name:'Development',keywords:[]},{id:'api-a',name:'API',parent:'dev-a',keywords:[]},{id:'ops',name:'Operations',keywords:[]},{id:'ops-api',name:'API',parent:'ops',keywords:[]}];
    snap.workspaces[w.id].topic='api-a';
    const second={...structuredClone(w),id:'other-repo-work',name:'Other repo task',repoId:'other-repo',repo:'Other',topic:'api-b'};
    const third={...structuredClone(w),id:'ops-work',name:'Operations task',topic:'ops-api'};
    snap.workspaces[second.id]=second;snap.workspaces[third.id]=third;
    snap.repos[0].workspaceIds.push(third.id);
    snap.repos.push({id:'other-repo',name:'Other',topics:[{id:'dev-b',name:'Development',keywords:[]},{id:'api-b',name:'API',parent:'dev-b',keywords:[]}],workspaceIds:[second.id]});
    const f=await fixture('en',{},snap);
    const choose=(names)=>{
        const key=JSON.stringify(names);
        const chip=[...f.document.querySelectorAll('.rchip')].find(el=>el.dataset.topicScope===key);
        assert.ok(chip,key);chip.click();
    };
    try {
        f.document.querySelector('[data-scope-mode=topic]').click();
        assert.equal(f.document.querySelectorAll('.gc').length,3);
        choose(['development']);
        assert.equal(f.document.querySelectorAll('.gc').length,2);
        assert.equal(f.document.querySelector('.topic-children').hidden,false);
        assert.deepEqual([...f.document.querySelectorAll('.g-label.repo')].map(el=>el.textContent).sort(),['Example','Other']);
        choose(['development','api']);
        assert.equal(f.document.querySelectorAll('.gc').length,2);
        choose(['operations']);choose(['operations','api']);
        assert.equal(f.document.querySelector('.gc-title').textContent,third.name);
        assert.equal(f.document.querySelectorAll('.gc').length,1);
        const view=(label)=>[...f.document.querySelectorAll('.toolbar .seg button')].find(el=>el.textContent===label).click();
        view('Board');
        assert.equal(f.document.querySelectorAll('.ws').length,1);
        view('Agent');
        assert.equal(f.document.querySelectorAll('.agent-card').length,1);
        view('Graph');
        f.document.querySelector('[data-scope-mode=repo]').click();
        assert.equal(f.document.querySelectorAll('.gc').length,2);
        f.document.querySelector('[data-scope-mode=topic]').click();
        assert.equal(f.document.querySelectorAll('.gc').length,1);
        assert.equal(f.stored['pod.prefs'].topicScope,'["operations","api"]');
        assert.equal(f.stored['pod.prefs'].repo,w.repoId);
        const reopened=await fixture('en',f.stored,snap);
        try {
            assert.equal(reopened.document.querySelector('[data-scope-mode=topic]').getAttribute('aria-selected'),'true');
            assert.equal(reopened.document.querySelectorAll('.gc').length,1);
            assert.equal(reopened.document.querySelector('.gc-title').textContent,third.name);
        } finally {await reopened.close();}
        assert.equal(f.calls.some(c=>/control.send|assignTopic|setStatus|launchAgent/.test(c.name)),false);
    } finally {await f.close();}
});

test('하위 주제의 부모만 바뀌어도 기존 좌표를 재사용하지 않고 새 묶음을 그린다', async () => {
    const f=await fixture();
    try {
        const next=snapshot();
        next.repos[0].topics=[{id:'one',name:'One',keywords:[]},{id:'two',name:'Two',keywords:[]},{id:'child',name:'Child',parent:'one',keywords:[]}];
        next.workspaces[w.id].topic='child';
        const other={...structuredClone(w),id:'second-work',name:'Second',topic:'two'};
        next.workspaces[other.id]=other;next.repos[0].workspaceIds.push(other.id);
        f.emit(next);
        await wait(()=>f.document.querySelectorAll('.gh-name').length===3);
        const changed=structuredClone(next);changed.repos[0].topics[2].parent='two';
        f.emit(changed);
        await wait(()=>f.document.querySelectorAll('.gh-name').length===2);
        assert.deepEqual([...f.document.querySelectorAll('.gh-name')].map(el=>el.textContent).sort(),['Child','Two']);
    } finally {await f.close();}
});

test('자동 정리는 수동 위치가 없어도 항상 표시하고 현재 보기의 위치만 초기화한다', async () => {
    const active=JSON.stringify(['topic',w.repoId,w.id]);
    const other=JSON.stringify(['status',w.repoId,w.id]);
    const positions={[active]:{x:900,y:800},[other]:{x:-300,y:-200}};
    const f=await fixture('ko',{'pod.prefs':{view:'graph',repo:w.repoId,lang:'ko',groupBy:'topic',graphPositions:positions}});
    try {
        const button=f.document.querySelector('.g-autolayout');
        assert.ok(button);
        assert.equal(button.hidden,false);
        button.click();
        await wait(()=>!!f.stored['pod.prefs'] && !f.stored['pod.prefs'].graphPositions[active]);
        assert.deepEqual(f.stored['pod.prefs'].graphPositions,{[other]:positions[other]});
        assert.equal(f.document.querySelector('.g-autolayout').hidden,false);
        const first=f.stored['pod.prefs'].graphPositions;
        f.document.querySelector('.g-autolayout').click();
        assert.deepEqual(f.stored['pod.prefs'].graphPositions,first);
        assert.equal(f.calls.some(c=>/assignTopic|setStatus|control.send|launchAgent/.test(c.name)),false);
    } finally {await f.close();}
});

test('날짜 탐색은 지도 위에 독립된 행으로 두고 관제와 함께 접히거나 이동하지 않는다',async()=>{
    const f=await fixture('ko');
    try{
        const strip=f.document.querySelector('.progress-strip'),stage=f.document.querySelector('.graph-stage');
        assert.equal(stage.firstElementChild,strip);
        assert.equal(strip.nextElementSibling,f.document.querySelector('.graph-wrap'));
        f.document.querySelector('.gc-head').click();
        f.document.querySelector('.dk-fold').click();
        assert.equal(stage.firstElementChild,strip);
        assert.equal(f.document.querySelector('.control').contains(strip),false);
    }finally{await f.close();}
});

test('기록 지도는 현재의 겹친 수동 위치를 따르지 않고 자동 정리해도 현재 배치를 보존한다',async()=>{
    const source=snapshot();source.at=Date.now();
    const other={...structuredClone(source.workspaces[w.id]),id:'another-work',name:'Another task'};
    other.agents[0].key='another-session';
    source.workspaces[other.id]=other;source.repos[0].workspaceIds.push(other.id);
    const positions=Object.fromEntries([w.id,other.id].map(id=>[JSON.stringify(['topic',w.repoId,id]),{x:120,y:160}]));
    const f=await fixture('ko',{'pod.prefs':{view:'graph',repo:w.repoId,lang:'ko',groupBy:'topic',graphPositions:positions}},source);
    const coordinates=()=>[...f.document.querySelectorAll('.g-ws')].map(el=>el.getAttribute('transform'));
    const separated=()=>{
        const boxes=[...f.document.querySelectorAll('.g-ws')].map(el=>{
            const [x,y]=el.getAttribute('transform').match(/-?\d+(?:\.\d+)?/g).map(Number),fo=el.querySelector('foreignObject');
            return {x:x+Number(fo.getAttribute('x')),y:y+Number(fo.getAttribute('y')),w:Number(fo.getAttribute('width')),h:Number(fo.getAttribute('height'))};
        });
        const [a,b]=boxes;
        return boxes.length===2&&(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y);
    };
    try{
        await wait(()=>f.calls.some(c=>c.name==='pod.progress.view'));
        await wait(()=>coordinates().every(value=>value==='translate(120.0 160.0)'));
        const next=structuredClone(source);next.at++;
        Object.values(next.workspaces).forEach(work=>work.agents[0].lastMessage='Observed change');f.emit(next);
        await wait(()=>f.document.querySelectorAll('.gc-progress').length===2);
        f.document.querySelector('.progress-today').click();
        await wait(()=>f.document.querySelectorAll('.progress-day-work').length===2);
        const button=f.document.querySelector('.g-autolayout');
        assert.equal(button.disabled,false);
        await wait(separated);
        button.click();
        await wait(separated);
        assert.deepEqual(f.stored['pod.prefs'].graphPositions,positions);
        f.document.querySelector('.progress-now').click();
        await wait(()=>coordinates().every(value=>value==='translate(120.0 160.0)'));
        assert.deepEqual(f.stored['pod.prefs'].graphPositions,positions);
        assert.equal(f.calls.some(c=>/assignTopic|setStatus|control.send|launchAgent/.test(c.name)),false);
    }finally{await f.close();}
});

test('분류안은 주제 트리·이동 근거를 검토한 뒤에만 적용하고 실패 시 검토창을 유지한다', async () => {
    const f=await fixture();
    const plan={repoId:w.repoId,baseFingerprint:'test',topics:[{id:'product',name:'Product',keywords:[]},{id:'review',name:'Review',parent:'product',keywords:[]}],assignments:[{workspaceId:w.id,topicId:'review',reason:'Explicit review question'}]};
    try {
        f.control({rev:4,topicPlan:plan});
        assert.equal(f.calls.some(c=>c.name==='pod.applyTopicPlan'),false);
        f.document.querySelector('.dk-topic-proposal button').click();
        assert.ok(f.document.querySelector('.topic-review-tree').textContent.includes('Product'));
        assert.ok(f.document.querySelector('.topic-review-changes').textContent.includes('Explicit review question'));
        f.failTopicApply(true);f.document.querySelector('form button[type=submit]').click();
        await wait(()=>!!f.document.querySelector('.toast.err'));
        assert.ok(f.document.querySelector('form.sheet'));
        f.failTopicApply(false);f.document.querySelector('form button[type=submit]').click();
        await wait(()=>!f.document.querySelector('form.sheet'));
        assert.equal(f.calls.filter(c=>c.name==='pod.applyTopicPlan').length,2);
    } finally {await f.close();}
});

test('날짜 기록은 같은 지도에 과거 이름을 보이고 지시를 잠근 뒤 정확한 현재 대상으로 이어간다',async()=>{
    const source=snapshot();source.at=Date.now();source.workspaces[w.id].agents[0].tool=null;
    const f=await fixture('ko',{},source);
    try {
        await wait(()=>f.calls.some(c=>c.name==='pod.progress.view'));
        f.document.querySelector('.gc-sess').click();
        const area=f.document.querySelector('.dk-composer textarea');area.value='Keep this draft';area.dispatchEvent(new f.window.Event('input'));
        const changed=structuredClone(source);changed.at+=1;changed.workspaces[w.id].agents[0].lastMessage='A newly observed result';f.emit(changed);
        await wait(()=>f.document.querySelector('.gc-progress')?.textContent.includes('1'));
        changed.at+=1;changed.workspaces[w.id].name='Renamed current work';f.emit(structuredClone(changed));
        f.document.querySelector('.progress-today').click();
        await wait(()=>!!f.document.querySelector('.progress-day-work'));f.document.querySelector('.progress-day-work').click();await wait(()=>!!f.document.querySelector('.progress-entry'));
        assert.equal(f.document.querySelector('.control').dataset.history,'true');
        assert.equal(f.document.querySelector('.gc-title').textContent,'Example task');
        assert.equal(area.value,'Keep this draft');assert.equal(area.readOnly,true);
        assert.equal(f.document.querySelector('.dk-brief-now').disabled,true);
        assert.equal(f.document.querySelector('.gc-add').disabled,true);
        assert.equal(f.document.querySelector('.progress-evidence').open,false);
        f.document.querySelector('.dk-composer .send').click();
        assert.equal(f.calls.some(c=>c.name==='pod.control.send'),false);
        f.document.querySelector('.progress-resume').click();
        await wait(()=>f.document.querySelector('.control').dataset.history==='false');
        assert.equal(f.document.querySelector('.gc-title').textContent,'Renamed current work');
        assert.ok(f.document.querySelector('.dk-target').textContent.includes(w.agents[0].title));
        assert.equal(area.value,'Keep this draft');assert.equal(area.readOnly,false);
        assert.equal(f.calls.some(c=>/send|setStatus|focusAgent|openWorkspace|conversation/.test(c.name)),false);
    }finally{await f.close();}
});

test('근거의 분류는 작업 상태를 바꾸지 않고 경험치 UI를 표시하지 않는다',async()=>{
    const source=snapshot();source.at=Date.now();
    const f=await fixture('ko',{},source);
    try{
        await wait(()=>f.calls.some(c=>c.name==='pod.progress.view'));
        const next=structuredClone(source);next.at+=1;next.workspaces[w.id].agents[0].lastMessage='<script>window.evil=true</script> Found a reproduction condition';f.emit(next);
        await wait(()=>!!f.document.querySelector('.gc-progress'));
        f.document.querySelector('.progress-today').click();await wait(()=>!!f.document.querySelector('.progress-day-work'));f.document.querySelector('.progress-day-work').click();await wait(()=>!!f.document.querySelector('.progress-evidence'));
        const details=f.document.querySelector('.progress-evidence');details.open=true;
        assert.equal(details.querySelector('script'),null);assert.equal(f.window.evil,undefined);
        [...details.querySelectorAll('button')].find(b=>b.textContent==='기록 분류').click();
        [...f.document.querySelectorAll('.menu .mi')].find(b=>b.textContent==='조사').click();
        await wait(()=>f.document.querySelector('.progress-evidence')?.textContent.includes('사용자 확인'));
        assert.equal(f.document.querySelector('.progress-entry-xp,.progress-profile'),null);
        assert.equal(f.document.querySelector('.progress-evidence').open,true);
        assert.equal(f.calls.some(c=>/send|setStatus|openWorkspace/.test(c.name)),false);
        [...f.document.querySelectorAll('.progress-evidence button')].find(b=>b.textContent==='진전 기록 취소').click();
        await wait(()=>f.document.querySelector('.progress-evidence')?.textContent.includes('진전 기록 취소됨'));
        assert.equal(f.document.querySelector('.progress-evidence').textContent.includes('진전 기록 취소됨'),true);
    }finally{await f.close();}
});

test('질문 없는 대기는 조용하게 표시하고 날짜 전환은 모델 호출·완료 처리를 만들지 않는다',async()=>{
    const source=snapshot();source.at=Date.now();source.workspaces[w.id].agents[0].tool=null;
    const f=await fixture('ko',{},source);
    try{
        await wait(()=>f.calls.some(c=>c.name==='pod.progress.view'));
        assert.equal(f.document.querySelector('.gc').dataset.attention,'false');
        const input=f.document.querySelector('.progress-date');input.value='2020-01-01';input.dispatchEvent(new f.window.Event('change'));
        await wait(()=>f.document.querySelector('.progress-context')?.textContent.includes('기록 수집 전'));
        assert.equal(f.document.querySelectorAll('.gc').length,0);
        assert.equal(f.calls.some(c=>/send|setStatus|control.watch.check/.test(c.name)),false);
        f.document.querySelector('.progress-now').click();
        await wait(()=>!!f.document.querySelector('.gc'));
        assert.equal(f.document.querySelectorAll('.gc-glyph[data-type="claude"] svg').length,1);
        assert.equal(f.document.querySelector('.session-figure'),null);
    }finally{await f.close();}
});

test('사라진 작업은 현재의 다른 작업으로 재연결하지 않고 과거 기록을 유지한다',async()=>{
    const source=snapshot();source.at=Date.now();const f=await fixture('ko',{},source);
    try{
        await wait(()=>f.calls.some(c=>c.name==='pod.progress.view'));
        const changed=structuredClone(source);changed.at+=1;changed.workspaces[w.id].agents[0].lastMessage='Historical result';f.emit(changed);
        await wait(()=>!!f.document.querySelector('.gc-progress'));
        f.emit({at:changed.at+1,repos:[],workspaces:{},statuses:[]});
        f.document.querySelector('.progress-today').click();await wait(()=>!!f.document.querySelector('.progress-day-work'));
        f.document.querySelector('.progress-day-work').click();await wait(()=>!!f.document.querySelector('.progress-resume'));
        f.document.querySelector('.progress-resume').click();
        assert.equal(f.document.querySelector('.control').dataset.history,'true');
        assert.equal(f.document.querySelector('.progress-evidence p').textContent,'Historical result');
        assert.equal(f.calls.some(c=>/send|setStatus|openWorkspace|focusAgent/.test(c.name)),false);
    }finally{await f.close();}
});

test('중요도 배지에서 P0를 지정하고 자동으로 복귀해도 세션 지시·작업 상태는 바뀌지 않는다',async()=>{
    const f=await fixture('ko');
    try{
        assert.equal(f.document.querySelector('.gc .work-priority').textContent,'P1');
        f.document.querySelector('.gc .work-priority').click();
        [...f.document.querySelectorAll('.menu .mi')].find(b=>b.textContent.startsWith('P0')).click();
        await wait(()=>f.document.querySelector('.gc .work-priority')?.textContent==='P0');
        assert.equal(f.stored['pod.work-priorities.v1'][w.id].level,'P0');
        f.document.querySelector('.gc-sess').click();
        assert.equal(f.document.querySelector('.dk-context .work-priority').textContent,'P0');
        assert.equal(f.document.querySelector('.dk-priority-reason').textContent,'사용자 지정');
        f.document.querySelector('.gc .work-priority').click();
        [...f.document.querySelectorAll('.menu .mi')].find(b=>b.textContent==='자동 분류').click();
        await wait(()=>f.document.querySelector('.gc .work-priority')?.textContent==='P1');
        assert.equal(f.document.querySelector('.progress-profile,.progress-xp-track,.progress-entry-xp'),null);
        assert.equal(f.calls.some(c=>/control.send|setStatus|focusAgent|openWorkspace/.test(c.name)),false);
    }finally{await f.close();}
});

test('중요도 필터는 P0 지정 작업만 보여주고 저장 실패는 이전 배지를 유지한다',async()=>{
    const source=snapshot(),second=structuredClone(w);second.id='second';second.name='Other task';second.agents=[];source.workspaces.second=second;source.repos[0].workspaceIds.push('second');
    const f=await fixture('ko',{},source);
    try{
        const first=f.document.querySelector(`[data-work="${w.id}"] .work-priority`);first.click();
        [...f.document.querySelectorAll('.menu .mi')].find(b=>b.textContent.startsWith('P0')).click();
        await wait(()=>f.document.querySelector(`[data-work="${w.id}"] .work-priority`)?.textContent==='P0');
        f.document.querySelector('.priority-filter').click();[...f.document.querySelectorAll('.menu .mi')].find(b=>b.textContent==='P0').click();
        assert.equal(f.document.querySelectorAll('.gc').length,1);
        assert.equal(f.document.querySelector('.gc').dataset.work,w.id);
        f.fail(true);f.document.querySelector('.gc .work-priority').click();[...f.document.querySelectorAll('.menu .mi')].find(b=>b.textContent.startsWith('P2')).click();
        await wait(()=>f.calls.filter(c=>c.name==='pod.priority.set').length===2);
        assert.equal(f.document.querySelector('.gc .work-priority').textContent,'P0');
        assert.equal(f.stored['pod.work-priorities.v1'][w.id].level,'P0');
    }finally{await f.close();}
});
