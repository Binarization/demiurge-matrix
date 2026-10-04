import { expect, test } from 'bun:test'
import { addFollowUps, currentFeeling, describeGap, dueFollowUps, feelingFrom, presenceContext, quietBrief, returnBrief, settleFollowUps, shouldGreetOnReturn, shouldSpeakWhileQuiet } from '../src/lib/companion'
import { createSession, loadConversation, saveConversation } from '../src/lib/conversation-store'
import { parseReflection } from '../src/lib/reflection'

const HOUR = 3_600_000
function storage() {
    const map = new Map<string,string>()
    return { getItem: (key:string) => map.get(key) ?? null, setItem: (key:string,value:string) => { map.set(key,value) } }
}

test('she speaks first only after a real gap, and never stacks greetings', () => {
    const now = 100 * HOUR
    const session = createSession()
    expect(shouldGreetOnReturn(session, now)).toBe(false)
    session.messages.push({id:'u',role:'user',content:'明天面试',timestamp:now - HOUR,status:'complete'})
    expect(shouldGreetOnReturn(session, now)).toBe(false)
    expect(shouldGreetOnReturn(session, now + 3 * HOUR)).toBe(true)
    session.messages.push({id:'g',role:'assistant',content:'<emote/> 面试怎么样？',timestamp:now + 3 * HOUR,status:'complete',kind:'greeting'})
    expect(shouldGreetOnReturn(session, now + 30 * HOUR)).toBe(false)
})

test('follow-ups become due once, are deduplicated, and go stale instead of being asked late', () => {
    const now = 1_000 * HOUR
    let items = addFollowUps([], [{topic:'周五面试的结果',askAfterHours:20},{topic:'周五面试的结果',askAfterHours:5}], now)
    expect(items).toHaveLength(1)
    expect(dueFollowUps(items, now + 10 * HOUR)).toHaveLength(0)
    const due = dueFollowUps(items, now + 21 * HOUR)
    expect(due.map(item => item.topic)).toEqual(['周五面试的结果'])
    items = settleFollowUps(items, due, now + 21 * HOUR)
    expect(dueFollowUps(items, now + 22 * HOUR)).toHaveLength(0)

    const stale = addFollowUps([], [{topic:'体检',askAfterHours:1}], now)
    expect(dueFollowUps(stale, now + 10 * 24 * HOUR)).toHaveLength(0)
    expect(settleFollowUps(stale, [], now + 10 * 24 * HOUR)[0]?.status).toBe('dropped')
})

test('presence and return context describe the real gap and transcript tail', () => {
    const now = new Date(2026, 8, 29, 23, 30).getTime()
    const session = createSession()
    session.messages.push({id:'u',role:'user',content:'今天好累',timestamp:now - 2 * 24 * HOUR,status:'complete'},
        {id:'a',role:'assistant',content:'<emote sad=0.3/> 辛苦了。',timestamp:now - 2 * 24 * HOUR,status:'complete'})
    const due = addFollowUps([], [{topic:'考试成绩',askAfterHours:1}], now - 3 * HOUR)
    const presence = presenceContext(session, due, now)
    expect(presence).toContain('星期二 23:30（深夜')
    expect(presence).toContain('约2天前')
    expect(presence).toContain('考试成绩')
    const brief = returnBrief(session, due, now)
    expect(brief).toContain('昔涟：辛苦了。')
    expect(brief).not.toContain('<emote')
    expect(describeGap(5 * 60_000)).toBe('刚刚还在聊')
})

test('greeting kind and follow-ups survive reload; malformed follow-ups are dropped', () => {
    const session = createSession()
    session.messages.push({id:'g',role:'assistant',content:'晚上好',timestamp:1,status:'complete',kind:'greeting'})
    session.followUps = addFollowUps([], [{topic:'搬家',askAfterHours:48}], 1)
    const db = storage(); saveConversation(session, db)
    const raw = JSON.parse(db.getItem('demiurge_conversation_v1')!)
    raw.followUps.push({topic:42})
    db.setItem('demiurge_conversation_v1', JSON.stringify(raw))
    const restored = loadConversation(db)
    expect(restored.messages[0]?.kind).toBe('greeting')
    expect(restored.followUps?.map(item => item.topic)).toEqual(['搬家'])
})

test('reflection output parses both the object form and the legacy array', () => {
    const parsed = parseReflection('```json\n{"memories":[{"content":"伙伴在准备面试"}],"follow_ups":[{"topic":"面试结果","ask_after_hours":30},{"topic":"","ask_after_hours":3}]}\n```')
    expect(parsed.memories).toHaveLength(1)
    expect(parsed.followUps).toEqual([{topic:'面试结果',askAfterHours:30}])
    const legacy = parseReflection('[{"content":"a"},{"content":"b"}]')
    expect(legacy.memories).toHaveLength(2)
    expect(legacy.followUps).toEqual([])
    expect(parseReflection('没有')).toEqual({memories:[],followUps:[]})
})

test('she breaks a long silence at most once, and only after a completed exchange', () => {
    const now = 200 * HOUR
    const session = createSession()
    const state = { now, lastActivityAt: now - 15 * 60_000 }
    expect(shouldSpeakWhileQuiet(session, state)).toBe(false)
    session.messages.push({id:'u',role:'user',content:'嗯',timestamp:now - 20 * 60_000,status:'complete'},
        {id:'a',role:'assistant',content:'<emote/> 好。',timestamp:now - 20 * 60_000,status:'complete'})
    expect(shouldSpeakWhileQuiet(session, { now, lastActivityAt: now - 5 * 60_000 })).toBe(false)
    expect(shouldSpeakWhileQuiet(session, state)).toBe(true)
    session.messages.push({id:'q',role:'assistant',content:'<emote/> 光移到秋千上了。',timestamp:now - 60_000,status:'complete',kind:'greeting'})
    expect(shouldSpeakWhileQuiet(session, { now: now + 2 * HOUR, lastActivityAt: now - 15 * 60_000 })).toBe(false)
    const failed = createSession()
    failed.messages.push({id:'u',role:'user',content:'？',timestamp:now - HOUR,status:'interrupted'})
    expect(shouldSpeakWhileQuiet(failed, state)).toBe(false)
})

test('the quiet brief tells her how long it has been and what she did meanwhile', () => {
    const now = new Date(2026, 9, 4, 15, 10).getTime()
    const session = createSession()
    session.messages.push({id:'u',role:'user',content:'先去忙了',timestamp:now - 14 * 60_000,status:'complete'},
        {id:'a',role:'assistant',content:'<emote relaxed=0.3/> 去吧。',timestamp:now - 14 * 60_000,status:'complete'})
    session.sceneEvents = [
        {timestamp: now - 9 * 60_000, action: '自己想起了：伙伴喜欢星星', outcome: 'complete'},
        {timestamp: now - 8 * 60_000, action: '挥手', outcome: 'complete'},
        {timestamp: now - 2 * HOUR, action: '自己伸懒腰', outcome: 'complete'},
    ]
    const brief = quietBrief(session, [], 13 * 60_000, now)
    expect(brief).toContain('约13分钟没有动静')
    expect(brief).toContain('昔涟：去吧。')
    expect(brief).toContain('自己想起了：伙伴喜欢星星')
    expect(brief).not.toContain('挥手')
    expect(brief).not.toContain('伸懒腰')
})

test('a lingering feeling colours her context until it fades, and survives reload', () => {
    const now = 500 * HOUR
    const session = createSession()
    session.messages.push({id:'u',role:'user',content:'你总是敷衍',timestamp:now - 10 * HOUR,status:'complete'})
    expect(feelingFrom(null, now)).toBeUndefined()
    session.feeling = feelingFrom({ note: '伙伴说她敷衍，她还有点难过', hours: 24 }, now - 10 * HOUR)
    expect(presenceContext(session, [], now)).toContain('还有点难过')
    expect(presenceContext(session, [], now)).toContain('约10小时前')
    expect(returnBrief(session, [], now)).toContain('还有点难过')
    expect(presenceContext(session, [], now + 15 * HOUR)).not.toContain('难过')
    expect(currentFeeling(session.feeling, now + 15 * HOUR)).toBeUndefined()
    const db = storage(); saveConversation(session, db)
    expect(loadConversation(db).feeling?.note).toBe('伙伴说她敷衍，她还有点难过')
    const raw = JSON.parse(db.getItem('demiurge_conversation_v1')!); raw.feeling = { note: 3 }
    db.setItem('demiurge_conversation_v1', JSON.stringify(raw))
    expect(loadConversation(db).feeling).toBeUndefined()
})
