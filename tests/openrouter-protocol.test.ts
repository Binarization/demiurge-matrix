import { expect, test } from 'bun:test'
import { assistantMessageToJSON } from '@openrouter/sdk/models/assistantmessage.js'
import { toolResponseMessageToJSON } from '@openrouter/sdk/models/toolresponsemessage.js'
import { OpenRouterClient } from '../src/lib/openrouter'

test('SDK serialization preserves matching assistant calls and tool responses', async () => {
    const client = new OpenRouterClient({ apiKey: 'test-only-key', model: 'test-model' })
    let wire: any[] = []
    // Intercept before HTTP, but exercise the installed SDK's real serializers.
    ;(client as any).client = { chat: { send: async (body: any) => {
        wire = body.messages.map((message: any) => JSON.parse(message.role === 'assistant'
            ? assistantMessageToJSON(message)
            : toolResponseMessageToJSON(message)))
        return { choices: [{ message: { content: 'done' } }] }
    } } }
    await client.sendChat([
        { role: 'assistant', content: '', tool_calls: [{ id:'c1', type:'function', function: { name:'recall_memory', arguments:'{}' } }] },
        { role: 'tool', content:'{"memories":[{"content":"猫叫小白"}]}', tool_call_id:'c1' },
    ])
    expect(wire[0].tool_calls[0].id).toBe('c1')
    expect(wire[1].tool_call_id).toBe('c1')
    expect(JSON.parse(wire[1].content).memories[0].content).toBe('猫叫小白')
})
