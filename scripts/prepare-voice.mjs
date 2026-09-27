import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
const [voiceDir, bertDir] = process.argv.slice(2)
if (!voiceDir || !bertDir)
    throw new Error('Usage: npm run voice:prepare -- <cyrene_chinese directory> <BERT directory>')
const out = path.resolve('public/voice')
await mkdir(out, { recursive: true })
const files = {
    model: [voiceDir, 'cyrene_chinese_e100_s1800.onnx'],
    bert: [bertDir, 'model_fp16.onnx'],
    tokenizer: [bertDir, 'tokenizer.json'],
    style: [voiceDir, 'style_vectors.npy'],
    config: [voiceDir, 'config.json'],
}
const manifest = { version: 1, files: {} }
for (const [key, [dir, name]] of Object.entries(files)) {
    const source = path.join(dir, name)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(source)) hash.update(chunk)
    const digest = hash.digest('hex')
    const dest = `${key}-${digest.slice(0, 16)}${path.extname(name)}`
    await copyFile(source, path.join(out, dest))
    manifest.files[key] = { url: dest, sha256: digest }
}
const config = JSON.parse(await readFile(path.join(voiceDir, 'config.json'), 'utf8'))
if (config.data.sampling_rate !== 44100 || !config.data.add_blank || config.data.use_jp_extra)
    throw new Error('Unsupported voice configuration')
await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log('Prepared local voice assets in public/voice (excluded from Git).')
