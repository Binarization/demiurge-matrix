import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

if (process.env.CF_PAGES !== '1' && !process.argv.includes('--always')) process.exit(0)
const root = resolve('dist')
const oversized = []
async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await scan(path)
        else if ((await stat(path)).size > 25 * 1024 * 1024) oversized.push(relative(root, path))
    }
}
await scan(root)
if (oversized.length) {
    console.error('以下文件超过 Cloudflare Pages 的 25 MiB 单文件上限：\n' + oversized.join('\n'))
    console.error(
        '声音模型请托管在 R2 等资源服务，并设置 VITE_VOICE_BASE_URL；不要放入 Pages 的 public/voice。'
    )
    process.exit(1)
}
console.log('Pages asset check passed: all files are at most 25 MiB.')
