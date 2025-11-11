<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

type PathPoint = {
  x: number;
  y: number;
  nx: number;
  ny: number;
};

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  pathIndex: number;
  offset: number;
  speed: number;
  size: number;
  hue: number;
  sparklePhase: number;
  sparkleSpeed: number;
};

type Star = {
  x: number;
  y: number;
  baseSize: number;
  hue: number;
  phase: number;
  speed: number;
};

type CubeState = {
  rotX: number;
  rotY: number;
  rotZ: number;
  floatPhase: number;
};

type TrailPoint = {
  x: number;
  y: number;
  life: number;
  velocity: number;
};

const canvasRef = ref<HTMLCanvasElement | null>(null);

const PARTICLE_COUNT = 600;
const PATH_SEGMENTS = 720;
const STAR_COUNT = 280;
const CUBE_VERTICES = [
  { x: -1, y: -1, z: -1 },
  { x: 1, y: -1, z: -1 },
  { x: 1, y: 1, z: -1 },
  { x: -1, y: 1, z: -1 },
  { x: -1, y: -1, z: 1 },
  { x: 1, y: -1, z: 1 },
  { x: 1, y: 1, z: 1 },
  { x: -1, y: 1, z: 1 },
] as const;

const CUBE_EDGES: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

const state = {
  ctx: null as CanvasRenderingContext2D | null,
  width: 0,
  height: 0,
  path: [] as PathPoint[],
  particles: [] as Particle[],
  ribbonHalfWidth: 0,
  stars: [] as Star[],
  bgGradient: null as CanvasGradient | null,
  mouse: {
    x: 0,
    y: 0,
    active: false,
  },
  cube: {
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    floatPhase: 0,
  } as CubeState,
  pulsePhase: 0,
  gridPhase: 0,
  trail: [] as TrailPoint[],
  rafId: 0,
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const buildPath = (width: number, height: number) => {
  const centerX = width / 2;
  const centerY = height / 2;
  const scaleX = width * 0.35;
  const scaleY = height * 0.5;
  const points: PathPoint[] = new Array(PATH_SEGMENTS).fill(0).map((_, index) => {
    const t = (index / PATH_SEGMENTS) * Math.PI * 2;
    const sinT = Math.sin(t);
    const cosT = Math.cos(t);
    const x = centerX + sinT * scaleX;
    const y = centerY + sinT * cosT * scaleY;
    return { x, y, nx: 0, ny: 0 };
  });

  for (let i = 0; i < points.length; i += 1) {
    const prev = points[(i - 1 + points.length) % points.length]!;
    const next = points[(i + 1) % points.length]!;
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    const current = points[i]!;
    current.nx = -ty / len;
    current.ny = tx / len;
  }

  return points;
};

const samplePoint = (path: PathPoint[], index: number, offset: number) => {
  const len = path.length;
  if (!len) {
    return { x: 0, y: 0 };
  }
  const wrapped = ((index % len) + len) % len;
  const baseIndex = Math.floor(wrapped);
  const nextIndex = (baseIndex + 1) % len;
  const t = wrapped - baseIndex;

  const p1 = path[baseIndex]!;
  const p2 = path[nextIndex]!;
  const x = lerp(p1.x, p2.x, t);
  const y = lerp(p1.y, p2.y, t);
  const nx = lerp(p1.nx, p2.nx, t);
  const ny = lerp(p1.ny, p2.ny, t);

  return {
    x: x + nx * offset,
    y: y + ny * offset,
  };
};

const initParticles = () => {
  if (!state.path.length) {
    return;
  }
  const halfWidth = state.ribbonHalfWidth;

  state.particles = Array.from({ length: PARTICLE_COUNT }, () => {
    const pathIndex = Math.random() * state.path.length;
    const offset = (Math.random() * 2 - 1) * halfWidth;
    const target = samplePoint(state.path, pathIndex, offset);
    const hue = 190 + Math.random() * 50 - 25;
    return {
      x: target.x + (Math.random() - 0.5) * 30,
      y: target.y + (Math.random() - 0.5) * 30,
      vx: 0,
      vy: 0,
      pathIndex,
      offset,
      speed: 0.18 + Math.random() * 0.22,
      size: 1 + Math.random() * 1.8,
      hue,
      sparklePhase: Math.random() * Math.PI * 2,
      sparkleSpeed: 0.008 + Math.random() * 0.015,
    };
  });
};

const initStars = () => {
  state.stars = Array.from({ length: STAR_COUNT }, () => ({
    x: Math.random() * state.width,
    y: Math.random() * state.height,
    baseSize: 0.5 + Math.random() * 1.6,
    hue: 200 + Math.random() * 80 - 40,
    phase: Math.random() * Math.PI * 2,
    speed: 0.005 + Math.random() * 0.01,
  }));
};

const drawBackgroundGrid = () => {
  if (!state.ctx) {
    return;
  }
  const ctx = state.ctx;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const spacing = Math.max(80, Math.min(state.width, state.height) * 0.08);
  const offset = (state.gridPhase * spacing) % spacing;
  ctx.strokeStyle = 'rgba(80, 115, 220, 0.06)';
  ctx.lineWidth = 1;

  for (let x = -spacing; x < state.width + spacing; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x + offset, 0);
    ctx.lineTo(x + offset, state.height);
    ctx.stroke();
  }

  for (let y = -spacing; y < state.height + spacing; y += spacing) {
    ctx.beginPath();
    ctx.moveTo(0, y + offset);
    ctx.lineTo(state.width, y + offset);
    ctx.stroke();
  }

  ctx.restore();
};

const drawEnergyPulses = () => {
  if (!state.ctx) {
    return;
  }
  const ctx = state.ctx;
  const centerX = state.width / 2;
  const centerY = state.height / 2;
  const maxRadius = Math.min(state.width, state.height) * 0.35;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.lineWidth = 1.5;

  for (let i = 0; i < 3; i += 1) {
    const progress = (state.pulsePhase + i / 3) % 1;
    const radius = progress * maxRadius;
    const alpha = 0.04 + (1 - progress) * 0.08;
    ctx.strokeStyle = `rgba(120, 180, 255, ${alpha})`;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
};

const rotateVertex = (vertex: { x: number; y: number; z: number }, rx: number, ry: number, rz: number) => {
  let { x, y, z } = vertex;
  const cosX = Math.cos(rx);
  const sinX = Math.sin(rx);
  const cosY = Math.cos(ry);
  const sinY = Math.sin(ry);
  const cosZ = Math.cos(rz);
  const sinZ = Math.sin(rz);

  let y1 = y * cosX - z * sinX;
  let z1 = y * sinX + z * cosX;
  y = y1;
  z = z1;

  let x2 = x * cosY + z * sinY;
  let z2 = -x * sinY + z * cosY;
  x = x2;
  z = z2;

  let x3 = x * cosZ - y * sinZ;
  let y3 = x * sinZ + y * cosZ;
  x = x3;
  y = y3;

  return { x, y, z };
};

const updateCubeState = () => {
  state.cube.rotX += 0.01;
  state.cube.rotY += 0.006;
  state.cube.rotZ += 0.004;
  state.cube.floatPhase += 0.01;
  state.pulsePhase = (state.pulsePhase + 0.004) % 1;
  state.gridPhase = (state.gridPhase + 0.0008) % 1;
};

const drawCubeAndOrb = () => {
  if (!state.ctx) {
    return;
  }
  const ctx = state.ctx;
  const size = Math.min(state.width, state.height) * 0.03;
  const perspective = Math.max(state.width, state.height) * 1.2;
  const centerX = state.width / 2;
  const centerY = state.height / 2 + Math.sin(state.cube.floatPhase) * size * 0.15;
  const transformed = CUBE_VERTICES.map((vertex) => {
    const scaled = {
      x: vertex.x * size,
      y: vertex.y * size,
      z: vertex.z * size,
    };
    const rotated = rotateVertex(scaled, state.cube.rotX, state.cube.rotY, state.cube.rotZ);
    const depthScale = perspective / (perspective - rotated.z);
    return {
      x: centerX + rotated.x * depthScale,
      y: centerY + rotated.y * depthScale,
      depth: depthScale,
    };
  });

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  CUBE_EDGES.forEach(([startIdx, endIdx]) => {
    const start = transformed[startIdx];
    const end = transformed[endIdx];
    if (!start || !end) {
      return;
    }
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  });

  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  CUBE_EDGES.forEach(([startIdx, endIdx]) => {
    const start = transformed[startIdx];
    const end = transformed[endIdx];
    if (!start || !end) {
      return;
    }
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  });
  ctx.restore();

};

const drawPointerCue = () => {
  if (!state.ctx || !state.mouse.active) {
    return;
  }
  const ctx = state.ctx;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const pulse = 0.5 + 0.5 * Math.sin(state.cube.floatPhase * 3);
  const radius = 12 + pulse * 9;
  ctx.strokeStyle = `rgba(120, 210, 255, ${0.25 + pulse * 0.2})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(state.mouse.x, state.mouse.y, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = `rgba(120, 210, 255, ${0.08 + pulse * 0.1})`;
  ctx.beginPath();
  ctx.arc(state.mouse.x, state.mouse.y, 2 + pulse * 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

const drawPointerTrail = () => {
  if (!state.ctx || state.trail.length < 2) {
    return;
  }
  const ctx = state.ctx;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const avgLife = state.trail.reduce((acc, point) => acc + point.life, 0) / state.trail.length;
  const alpha = 0.12 + avgLife * 0.2;
  ctx.strokeStyle = `rgba(170, 225, 255, ${alpha})`;
  ctx.lineWidth = 2 + avgLife * 2;
  ctx.beginPath();
  ctx.moveTo(state.trail[0]!.x, state.trail[0]!.y);
  for (let i = 1; i < state.trail.length; i += 1) {
    const point = state.trail[i]!;
    ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();

  ctx.restore();
};

const updateTrail = () => {
  state.trail = state.trail
    .map((point) => ({
      ...point,
      life: point.life - (0.022 + point.velocity * 0.03),
    }))
    .filter((point) => point.life > 0);
};

const pushTrailPoint = (x: number, y: number) => {
  const prev = state.trail[state.trail.length - 1];
  const dx = prev ? x - prev.x : 0;
  const dy = prev ? y - prev.y : 0;
  const velocity = Math.min(1, Math.hypot(dx, dy) / 50);

  if (state.trail.length > 0) {
    state.trail = state.trail
      .map((point, index) => ({
        ...point,
        life: point.life - (0.04 + velocity * (index === state.trail.length - 1 ? 0.02 : 0.035)),
      }))
      .filter((point) => point.life > 0);
  }

  state.trail.push({ x, y, life: 1, velocity });
  if (state.trail.length > 95) {
    state.trail.splice(0, state.trail.length - 95);
  }
};

const updateParticles = () => {
  if (!state.path.length) {
    return;
  }
  const repelRadius = Math.min(state.width, state.height) * 0.25;
  const repelStrength = 0.45;

  state.particles.forEach((particle) => {
    particle.pathIndex = (particle.pathIndex + particle.speed) % state.path.length;
    const target = samplePoint(state.path, particle.pathIndex, particle.offset);
    const ax = (target.x - particle.x) * 0.05;
    const ay = (target.y - particle.y) * 0.05;
    particle.vx += ax;
    particle.vy += ay;

    if (state.mouse.active) {
      const dx = particle.x - state.mouse.x;
      const dy = particle.y - state.mouse.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0 && dist < repelRadius) {
        const force = (1 - dist / repelRadius) * repelStrength;
        particle.vx += (dx / dist) * force;
        particle.vy += (dy / dist) * force;
      }
    }

    particle.vx *= 0.9;
    particle.vy *= 0.9;

    particle.x += particle.vx;
    particle.y += particle.vy;
  });
};

const drawParticles = () => {
  if (!state.ctx || !state.path.length) {
    return;
  }
  const ctx = state.ctx;
  const ribbon = state.ribbonHalfWidth || 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(3, 5, 15, 0.22)';
  ctx.fillRect(0, 0, state.width, state.height);

  drawBackgroundGrid();
  drawEnergyPulses();

  if (state.bgGradient) {
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = state.bgGradient;
    ctx.fillRect(0, 0, state.width, state.height);
    ctx.globalAlpha = 1;
  }

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  state.stars.forEach((star) => {
    star.phase += star.speed;
    const twinkle = 0.6 + 0.4 * Math.sin(star.phase);
    ctx.fillStyle = `hsla(${star.hue}, 85%, 75%, ${0.15 + twinkle * 0.45})`;
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.baseSize * twinkle, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();

  drawCubeAndOrb();

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  state.particles.forEach((particle) => {
    particle.sparklePhase += particle.sparkleSpeed;
    const sparkle = 0.7 + 0.3 * Math.sin(particle.sparklePhase);
    const depthFactor = 0.5 + (Math.abs(particle.offset) / ribbon) * 0.4;
    const alpha = Math.min(1, depthFactor * sparkle);
    const coreColor = `hsla(${particle.hue}, 90%, ${75 + sparkle * 10}%, ${alpha})`;
    const haloColor = `hsla(${particle.hue}, 90%, 85%, ${alpha * 0.35})`;

    ctx.beginPath();
    ctx.fillStyle = haloColor;
    ctx.arc(particle.x, particle.y, particle.size * (1.8 + sparkle * 0.5), 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.fillStyle = coreColor;
    ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.restore();

  drawPointerTrail();
  drawPointerCue();
};

const animate = () => {
  updateCubeState();
  updateParticles();
  updateTrail();
  drawParticles();
  state.rafId = requestAnimationFrame(animate);
};

const handleResize = () => {
  const canvas = canvasRef.value;
  if (!canvas) {
    return;
  }
  const { innerWidth, innerHeight, devicePixelRatio } = window;
  state.width = innerWidth;
  state.height = innerHeight;
  const dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  state.ctx = ctx;
  state.path = buildPath(innerWidth, innerHeight);
  state.ribbonHalfWidth = Math.min(innerWidth, innerHeight) * 0.04;
  state.bgGradient = (() => {
    const gradient = ctx.createRadialGradient(
      innerWidth * 0.5,
      innerHeight * 0.4,
      Math.min(innerWidth, innerHeight) * 0.15,
      innerWidth * 0.5,
      innerHeight * 0.6,
      Math.max(innerWidth, innerHeight)
    );
    gradient.addColorStop(0, 'rgba(45, 58, 110, 0.7)');
    gradient.addColorStop(0.35, 'rgba(15, 12, 45, 0.9)');
    gradient.addColorStop(0.65, 'rgba(4, 6, 15, 1)');
    gradient.addColorStop(1, 'rgba(2, 4, 10, 1)');
    return gradient;
  })();
  initParticles();
  initStars();
};

const handlePointerMove = (event: MouseEvent) => {
  state.mouse.x = event.clientX;
  state.mouse.y = event.clientY;
  state.mouse.active = true;
  pushTrailPoint(event.clientX, event.clientY);
};

const handlePointerLeave = () => {
  state.mouse.active = false;
};

onMounted(() => {
  handleResize();
  window.addEventListener('resize', handleResize);
  window.addEventListener('mousemove', handlePointerMove);
  window.addEventListener('mouseleave', handlePointerLeave);
  state.rafId = requestAnimationFrame(animate);
});

onUnmounted(() => {
  cancelAnimationFrame(state.rafId);
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('mousemove', handlePointerMove);
  window.removeEventListener('mouseleave', handlePointerLeave);
});
</script>

<template>
  <div class="app-shell">
    <canvas ref="canvasRef" class="infinity-canvas"></canvas>
  </div>
</template>

<style scoped>
:global(html, body, #app) {
  height: 100%;
  width: 100%;
  margin: 0;
  padding: 0;
  background: #000;
}

.app-shell {
  position: fixed;
  inset: 0;
  background: #000;
  overflow: hidden;
  cursor: none;
}

.infinity-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

</style>
