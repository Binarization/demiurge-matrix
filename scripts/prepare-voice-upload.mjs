import { readFile, writeFile, mkdir, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
const source = resolve(process.argv[2] ?? 'public/voice')
const output = resolve(process.argv[3] ?? '/tmp/cyrene-voice-upload')
await mkdir(output, { recursive: true })
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
const assets = []
for (const entry of Object.values(manifest.files)) {
    if (!/^[\w.-]+$/.test(entry.url)) throw new Error('Invalid source filename')
    const file = await open(join(source, entry.url))
    const size = (await file.stat()).size
    const parts = []
    const fullHash = createHash('sha256')
    try {
        let offset = 0
        while (offset < size) {
            const buffer = Buffer.alloc(Math.min(64 * 1024 * 1024, size - offset))
            let read = 0
            while (read < buffer.length) {
                const result = await file.read(buffer, read, buffer.length - read, offset + read)
                if (!result.bytesRead) throw new Error('Unexpected end of model')
                read += result.bytesRead
            }
            fullHash.update(buffer)
            const hash = createHash('sha256').update(buffer).digest('hex')
            const key = 'part-' + hash + '.bin'
            await writeFile(join(output, key), buffer)
            parts.push({ key, size: buffer.length })
            offset += buffer.length
        }
    } finally {
        await file.close()
    }
    if (fullHash.digest('hex') !== entry.sha256)
        throw new Error('Model hash mismatch: ' + entry.url)
    assets.push({ path: entry.url, size, parts })
}
await writeFile('deploy/voice/assets.json', JSON.stringify(assets, null, 2) + '\n')
await writeFile('deploy/voice/manifest.json', JSON.stringify(manifest, null, 2) + '\n')
console.log('Prepared ' + assets.flatMap(a => a.parts).length + ' private R2 objects in ' + output)
