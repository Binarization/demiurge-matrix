<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

type TrailPoint = {
    x: number
    y: number
    life: number
    velocity: number
    incomingX: number
    incomingY: number
    outgoingX: number
    outgoingY: number
}

const canvasRef = ref<HTMLCanvasElement | null>(null)

const state = {
    ctx: null as CanvasRenderingContext2D | null,
    width: 0,
    height: 0,
    trail: [] as TrailPoint[],
    rafId: 0,
    pointer: {
        x: 0,
        y: 0,
        active: false,
    },
    pulsePhase: 0,
    fadeOut: false,
    fadeAlpha: 1,
}

const pushTrailPoint = (x: number, y: number) => {
    const prev = state.trail[state.trail.length - 1]
    const dx = prev ? x - prev.x : 0
    const dy = prev ? y - prev.y : 0
    const distance = Math.hypot(dx, dy)
    const velocity = Math.min(1, distance / 50)
    const incomingX = distance > 0.0001 ? dx : (prev?.incomingX ?? 0)
    const incomingY = distance > 0.0001 ? dy : (prev?.incomingY ?? 0)

    if (prev && distance) {
        prev.outgoingX = incomingX
        prev.outgoingY = incomingY
        prev.velocity = velocity
    }

    if (state.trail.length > 0) {
        state.trail = state.trail
            .map((point, index) => ({
                ...point,
                life:
                    point.life -
                    (0.04 + velocity * (index === state.trail.length - 1 ? 0.02 : 0.035)),
            }))
            .filter(point => point.life > 0)
    }

    state.trail.push({
        x,
        y,
        life: 1,
        velocity,
        incomingX,
        incomingY,
        outgoingX: incomingX,
        outgoingY: incomingY,
    })
    if (state.trail.length > 95) {
        state.trail.splice(0, state.trail.length - 95)
    }
}

const updateTrail = () => {
    state.trail = state.trail
        .map(point => ({
            ...point,
            life: point.life - (0.022 + point.velocity * 0.03),
        }))
        .filter(point => point.life > 0)
}

const drawTrail = () => {
    if (!state.ctx || state.trail.length < 2) {
        return
    }
    const ctx = state.ctx
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const avgLife = state.trail.reduce((acc, point) => acc + point.life, 0) / state.trail.length
    const alpha = 0.12 + avgLife * 0.2
    const width = 2 + avgLife * 2
    ctx.strokeStyle = `rgba(170, 225, 255, ${alpha})`
    ctx.lineWidth = width
    const points = state.trail
    const maxControl = 36
    const tension = 0.35

    const scaleControl = (vx: number, vy: number) => {
        const len = Math.hypot(vx, vy)
        if (!len) {
            return { x: 0, y: 0 }
        }
        const clamped = Math.min(maxControl, len * tension)
        const factor = clamped / len
        return { x: vx * factor, y: vy * factor }
    }

    ctx.beginPath()
    ctx.moveTo(points[0]!.x, points[0]!.y)
    for (let i = 1; i < points.length; i += 1) {
        const prev = points[i - 1]!
        const current = points[i]!
        const prevControl = scaleControl(prev.outgoingX, prev.outgoingY)
        const currentControl = scaleControl(current.incomingX, current.incomingY)
        const cp1x = prev.x + prevControl.x
        const cp1y = prev.y + prevControl.y
        const cp2x = current.x - currentControl.x
        const cp2y = current.y - currentControl.y
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, current.x, current.y)
    }

    ctx.stroke()
    ctx.restore()
}

const drawCursor = () => {
    if (!state.ctx || !state.pointer.active) {
        return
    }
    const ctx = state.ctx
    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    const pulse = 0.5 + 0.5 * Math.sin(state.pulsePhase * 3)
    const radius = 12 + pulse * 9
    ctx.strokeStyle = `rgba(120, 210, 255, ${0.25 + pulse * 0.2})`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(state.pointer.x, state.pointer.y, radius, 0, Math.PI * 2)
    ctx.stroke()

    ctx.fillStyle = `rgba(120, 210, 255, ${0.08 + pulse * 0.1})`
    ctx.beginPath()
    ctx.arc(state.pointer.x, state.pointer.y, 2 + pulse * 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
}

const draw = () => {
    if (!state.ctx) {
        return
    }
    const ctx = state.ctx
    ctx.clearRect(0, 0, state.width, state.height)
    ctx.save()
    if (state.fadeOut) {
        ctx.globalAlpha = state.fadeAlpha
    }
    drawTrail()
    drawCursor()
    ctx.restore()
}

const animate = () => {
    state.pulsePhase += 0.01
    updateTrail()
    if (state.fadeOut) {
        state.fadeAlpha -= 0.04
        if (state.fadeAlpha <= 0) {
            state.fadeAlpha = 0
            state.fadeOut = false
            state.trail = []
        }
    }
    draw()
    state.rafId = window.requestAnimationFrame(animate)
}

const handlePointerMove = (event: PointerEvent) => {
    state.pointer.x = event.clientX
    state.pointer.y = event.clientY
    state.pointer.active = true
    pushTrailPoint(event.clientX, event.clientY)
    if (state.fadeOut) {
        state.fadeOut = false
        state.fadeAlpha = 1
    }
}

const handlePointerLeave = () => {
    state.pointer.active = false
    if (window.matchMedia('(pointer: coarse)').matches) {
        state.fadeOut = true
        state.fadeAlpha = 1
    }
}

const handleTouchEnd = () => {
    state.pointer.active = false
    if (window.matchMedia('(pointer: coarse)').matches) {
        state.fadeOut = true
        state.fadeAlpha = 1
    }
}

const handleResize = () => {
    const canvas = canvasRef.value
    if (!canvas) {
        return
    }
    const { innerWidth, innerHeight, devicePixelRatio } = window
    state.width = innerWidth
    state.height = innerHeight
    const dpr = devicePixelRatio || 1
    canvas.width = innerWidth * dpr
    canvas.height = innerHeight * dpr
    canvas.style.width = `${innerWidth}px`
    canvas.style.height = `${innerHeight}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) {
        return
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)
    state.ctx = ctx
}

onMounted(() => {
    handleResize()
    window.addEventListener('resize', handleResize)
    window.addEventListener('pointermove', handlePointerMove, { passive: true })
    window.addEventListener('pointerleave', handlePointerLeave)
    window.addEventListener('touchend', handleTouchEnd)
    window.addEventListener('mouseout', handlePointerLeave)
    state.rafId = window.requestAnimationFrame(animate)
})

onUnmounted(() => {
    window.cancelAnimationFrame(state.rafId)
    window.removeEventListener('resize', handleResize)
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerleave', handlePointerLeave)
    window.removeEventListener('touchend', handleTouchEnd)
    window.removeEventListener('mouseout', handlePointerLeave)
})
</script>

<template>
    <canvas ref="canvasRef" class="pointer-overlay" aria-hidden="true"></canvas>
</template>

<style scoped>
.pointer-overlay {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 100;
    mix-blend-mode: screen;
}
</style>
