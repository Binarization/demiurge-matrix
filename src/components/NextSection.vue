<script setup lang="ts">
// Placeholder for the follow-up view that receives control after the landing explosion.
</script>

<template>
  <section class="next-section">
    <div class="next-section__content">
      <p class="next-section__eyebrow">你好，世界</p>
      <p class="next-section__body">在这里继续构建你的故事。</p>
    </div>
  </section>
</template>

<style scoped>
.next-section {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at top, #101018 0%, #050509 50%, #010103 100%);
  color: #fff;
  font-family: 'Space Grotesk', 'Inter', 'Segoe UI', sans-serif;
  text-align: center;
}

.next-section__content {
  padding: 32px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 24px;
  backdrop-filter: blur(16px);
  background: rgba(5, 5, 12, 0.85);
  min-width: 320px;
}

.next-section__eyebrow {
  font-size: 0.9rem;
  letter-spacing: 0.4em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 1rem;
}

h1 {
  font-size: clamp(2rem, 4vw, 3.5rem);
  margin: 0 0 1rem;
}

.next-section__body {
  margin: 0;
  font-size: 1.1rem;
  color: rgba(255, 255, 255, 0.75);
}
</style>
