/** Only tool-free final responses enter the visible/speech stream. */
export async function consumeChatStream(
    response: unknown,
    onDelta?: (text: string) => void,
    signal?: AbortSignal
): Promise<string> {
    const stream = response as AsyncIterable<any>
    if (!stream?.[Symbol.asyncIterator]) throw new Error('模型未返回可读取的文字流。')
    let content = ''
    let finished = false
    for await (const event of stream) {
        signal?.throwIfAborted()
        const data = event.data ?? event
        if (data.error) throw new Error(data.error.message ?? '模型流中断')
        const choice = data.choices?.find((c: any) => c.index === 0) ?? data.choices?.[0]
        if (!choice) continue // usage-only chunks
        const delta = choice.delta
        if (delta?.toolCalls?.length || delta?.tool_calls?.length)
            throw new Error('最终回答流意外包含工具调用。')
        if (finished && delta?.content) throw new Error('模型在结束标记后继续输出。')
        const text = delta?.content ?? delta?.refusal
        if (typeof text === 'string' && text) {
            content += text
            onDelta?.(text)
        }
        const reason = choice.finishReason ?? choice.finish_reason
        if (reason) {
            if (reason !== 'stop')
                throw new Error(`回答未正常完成（${reason}），已保留收到的文字。`)
            finished = true
        }
    }
    signal?.throwIfAborted()
    if (!finished) throw new Error('文字流提前断开，已保留收到的内容。')
    return content
}
