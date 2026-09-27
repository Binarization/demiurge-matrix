import { expect, test } from 'bun:test'
import { createSession, loadConversation, saveConversation, recentConversation, conversationRecallTool, CONVERSATION_KEY } from '../src/lib/conversation-store'
import { emptyMood, advanceMood, restingMood } from '../src/lib/interaction'

function storage() {
    const map = new Map<string,string>()
    return { map, getItem: (key:string) => map.get(key) ?? null, setItem: (key:string,value:string) => { map.set(key,value) } }
}
test('greeting, full transcript and mood survive reload while model context stays bounded', async () => {
    const session = createSession()
    session.messages.push({id:'g',role:'assistant',content:'你来啦，伙伴～',timestamp:1,status:'complete'})
    for(let i=0;i<30;i++) {
        session.messages.push({id:`u${i}`,role:'user',content:`约定${i}`,timestamp:i+2,status:'complete'})
        session.messages.push({id:`a${i}`,role:'assistant',content:`回答${i}`,timestamp:i+2,status:'complete'})
    }
    session.mood.happy = 0.6
    session.voiceEnabled = true
    session.voiceBackend = 'webgpu'
    const db=storage();saveConversation(session,db)
    const restored=loadConversation(db)
    expect(restored.messages).toHaveLength(61)
    expect(restored.messages[0]?.content).toBe('你来啦，伙伴～')
    expect(recentConversation(restored.messages)).toHaveLength(40)
    expect(restored.mood.happy).toBe(0.6)
    expect(restored.voiceEnabled).toBe(true)
    const result=await conversationRecallTool(()=>restored.messages).execute({query:'约定0'},{} as any)
    expect((result.output as any).messages[0].id).toBe('u0')
    expect(restored.messages).toHaveLength(61)
})
test('first greeting is included in restored model history', () => {
    const session=createSession()
    session.messages.push({id:'g',role:'assistant',content:'记得你喜欢花。',timestamp:1,status:'complete'})
    expect(recentConversation(session.messages)[0]?.content).toBe('记得你喜欢花。')
})
test('crashed pending turns recover as interrupted and speech interruption is explicit', () => {
    const session=createSession()
    session.messages.push({id:'u',role:'user',content:'未完成问题',timestamp:1,status:'pending'},
        {id:'a',role:'assistant',content:'文字已显示',timestamp:2,status:'complete',speechInterrupted:true})
    const db=storage();saveConversation(session,db)
    const restored=loadConversation(db)
    expect(restored.messages[0]?.status).toBe('interrupted')
    expect(recentConversation(restored.messages)[0]?.content).toContain('未收到最终回答')
    expect(recentConversation(restored.messages)[1]?.content).toContain('朗读被伙伴打断')
})
test('corrupt archives and quota errors surface without overwriting old data', () => {
    const db=storage();db.setItem(CONVERSATION_KEY,'{"version":42}')
    expect(()=>loadConversation(db)).toThrow()
    expect(db.getItem(CONVERSATION_KEY)).toBe('{"version":42}')
    expect(()=>saveConversation(createSession(),{setItem:()=>{throw new Error('quota')}})).toThrow('quota')
})
test('emotion carries between turns and eases toward rest over offline time', () => {
    const mood=emptyMood();mood.sad=0.8
    const next=advanceMood(mood,{happy:0.5},0)
    expect(next.sad).toBeGreaterThan(0)
    expect(next.happy).toBeGreaterThan(0)
    expect(restingMood(next,0)).toEqual(next)
    expect(restingMood(next,3_600_000).sad).toBeLessThan(next.sad)
})

test('legacy device voice cannot remain enabled after migration', () => {
    const db=storage()
    db.setItem(CONVERSATION_KEY,JSON.stringify({...createSession(),voiceEnabled:true,voiceBackend:'device'}))
    const session=loadConversation(db)
    expect(session.voiceEnabled).toBe(false)
    expect(session.voiceBackend).toBe('webgpu')
})
