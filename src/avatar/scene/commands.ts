import { BODY_ACTIONS, type BodyAction } from './BodyDirector'
import type { CameraView } from './CameraDirector'
export function parseSceneCue(text: string): { body?: BodyAction; camera?: CameraView } {
    const attrs = text.match(/^\s*<emote\b([^>]*)>/i)?.[1] ?? ''
    const body = attrs.match(/\bbody\s*=\s*["']?([a-z_]+)["']?/i)?.[1]
    const camera = attrs.match(/\bcamera\s*=\s*["']?([a-z_]+)["']?/i)?.[1]
    return {
        body: BODY_ACTIONS.includes(body as BodyAction) ? body as BodyAction : undefined,
        camera: ['companion', 'full', 'close'].includes(camera ?? '') ? camera as CameraView : undefined,
    }
}
