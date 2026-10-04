/**
 * Her life while the partner is quiet: self-initiated body actions, dwelling
 * on a memory, and the cue to speak first. Owns the activity clock and the
 * timing state the decisions in `@/lib/idle-life` need; the host supplies the
 * avatar, the guards that say whether acting is appropriate right now, and
 * the side effects (logging a scene event, speaking).
 */
import { onMounted, onUnmounted } from 'vue'
import type { BodyAction, SceneEvent } from '@/avatar/scene/BodyDirector'
import { memoryStore } from '@/lib/memory-store'
import { nextIdleBodyAction, pickMemoryToRecall, recallEventLabel, shouldRecallMemory } from '@/lib/idle-life'

type SceneState = {
    seated: boolean
    position?: number[]
    home: number[]
    cameraView?: string
}
export type IdleAvatar = {
    getSceneState: () => SceneState
    playBodyAction: (action: BodyAction, options?: { quiet?: boolean }) => boolean
    getVrmController?: () => { playFidget: (name: 'tilt') => boolean } | null | undefined
}

export type IdleLifeHost = {
    avatar: () => IdleAvatar | null | undefined
    /** True when she is free to act: page visible, nobody talking, composer empty, no partner-requested action. */
    free: () => boolean
    /** True while a partner-requested (non-quiet) body action is running. */
    busy: () => boolean
    disposed: () => boolean
    /** Record something she did on her own as a scene event. */
    recordSceneEvent: (action: string) => void
    /** Chance to speak first; called once per tick when she is free. */
    onQuietTick: () => void
    tickMs?: number
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

export function useIdleLife(host: IdleLifeHost) {
    let avatarReady = false
    let quietBusy = false
    let lastActivityAt = Date.now()
    let lastBodyAt = 0
    let lastIdleBodyAction: BodyAction | null = null
    let seatedSince: number | null = null
    let lastRecallAt = 0
    let recallInFlight = false

    const markActivity = () => {
        lastActivityAt = Date.now()
    }
    const setAvatarReady = () => {
        avatarReady = true
        markActivity()
    }
    /** Keep timing state in step with what the body actually did. */
    const noteSceneEvent = (event: SceneEvent, seated: boolean, wasSeated: boolean) => {
        quietBusy = event.phase === 'start' && event.quiet === true
        if (seated && !wasSeated) seatedSince = Date.now()
        if (!seated) seatedSince = null
        if (event.phase !== 'start') {
            lastBodyAt = Date.now()
            lastIdleBodyAction = event.quiet ? event.action : null
        }
    }

    // She dwells on something she remembers: the memory is really touched and
    // the moment is logged, so she can bring it up later without inventing anything.
    const rehearseMemory = async () => {
        if (recallInFlight) return
        recallInFlight = true
        lastRecallAt = Date.now()
        try {
            const picked = pickMemoryToRecall(await memoryStore.getAllValid(), Date.now())
            if (!picked || host.disposed() || !host.free()) return
            await memoryStore.recordAccess(picked.id)
            host.avatar()?.getVrmController?.()?.playFidget('tilt')
            host.recordSceneEvent(recallEventLabel(picked.content))
        } catch (error) {
            console.warn('Idle recall failed:', error)
        } finally {
            recallInFlight = false
        }
    }

    const tick = () => {
        const avatar = host.avatar()
        if (!avatar || !avatarReady || quietBusy || !host.free()) return
        host.onQuietTick()
        const scene = avatar.getSceneState()
        const position = scene.position ?? scene.home
        const action = nextIdleBodyAction({
            now: Date.now(),
            lastActivityAt,
            lastBodyAt,
            lastBodyAction: lastIdleBodyAction,
            seated: scene.seated,
            seatedSince,
            distanceFromHome: Math.hypot(position[0]! - scene.home[0]!, position[2]! - scene.home[2]!),
            cameraView: scene.cameraView,
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        })
        if (action) {
            avatar.playBodyAction(action, { quiet: true })
            return
        }
        if (shouldRecallMemory({ now: Date.now(), lastActivityAt, lastRecallAt, lastBodyAt, bodyBusy: quietBusy || host.busy() }))
            void rehearseMemory()
    }

    let timer: ReturnType<typeof setInterval> | undefined
    onMounted(() => {
        for (const name of ACTIVITY_EVENTS) window.addEventListener(name, markActivity, { passive: true })
        timer = setInterval(tick, host.tickMs ?? 5000)
    })
    onUnmounted(() => {
        for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, markActivity)
        clearInterval(timer)
    })

    return {
        markActivity,
        setAvatarReady,
        noteSceneEvent,
        get lastActivityAt() { return lastActivityAt },
    }
}
