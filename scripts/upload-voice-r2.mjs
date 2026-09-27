import { readFile, stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
const directory = resolve(process.argv[2] ?? '/tmp/cyrene-voice-upload')
const assets = JSON.parse(await readFile('deploy/voice/assets.json', 'utf8'))
const parts = [...new Map(assets.flatMap(a => a.parts).map(part => [part.key, part])).values()]
for (const part of parts) {
    if (
        !/^part-[a-f0-9]{64}\.bin$/.test(part.key) ||
        (await stat(join(directory, part.key))).size !== part.size
    )
        throw new Error('Invalid upload part: ' + part.key)
}
let next = 0
async function upload() {
    while (next < parts.length) {
        const part = parts[next++]
        console.log('Uploading ' + part.key)
        let code = 1
        for (let attempt = 0; attempt < 3 && code !== 0; attempt++) {
            if (attempt) await delay(2000 * attempt)
            const processHandle = spawn(
                process.execPath,
                [
                    'node_modules/wrangler/bin/wrangler.js',
                    'r2',
                    'object',
                    'put',
                    'demiurge-cyrene-voice/' + part.key,
                    '--file',
                    join(directory, part.key),
                    '--remote',
                    '--content-type',
                    'application/octet-stream',
                    '--config',
                    'deploy/voice/wrangler.jsonc',
                ],
                { stdio: 'inherit' }
            )
            code = await new Promise((resolve, reject) => {
                processHandle.on('error', reject)
                processHandle.on('exit', resolve)
            })
        }
        if (code !== 0) throw new Error('Upload failed: ' + part.key)
    }
}
const results = await Promise.allSettled([upload(), upload()])
if (results.some(result => result.status === 'rejected')) {
    for (const result of results) if (result.status === 'rejected') console.error(result.reason)
    process.exitCode = 1
} else console.log('All ' + parts.length + ' private model objects uploaded.')
