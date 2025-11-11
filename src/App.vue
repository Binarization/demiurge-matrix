<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import Landing from './components/Landing.vue';
import NextSection from './components/NextSection.vue';

type CurtainPhase = 'idle' | 'hold' | 'fade';
const CURTAIN_FADE_DELAY = 400;
const CURTAIN_FADE_DURATION = 1600;

const showNextSection = ref(false);
const curtainPhase = ref<CurtainPhase>('idle');
const curtainSkipTransition = ref(false);
let curtainTimer: number | undefined;

const handleLandingComplete = () => {
  curtainSkipTransition.value = true;
  curtainPhase.value = 'hold';
  showNextSection.value = true;
  if (curtainTimer) {
    window.clearTimeout(curtainTimer);
  }
  curtainTimer = window.setTimeout(() => {
    curtainSkipTransition.value = false;
    curtainPhase.value = 'fade';
  }, CURTAIN_FADE_DELAY);
};

const handleCurtainTransitionEnd = (event: TransitionEvent) => {
  if (event.propertyName !== 'opacity' || event.target !== event.currentTarget) {
    return;
  }
  if (curtainPhase.value === 'fade') {
    curtainPhase.value = 'idle';
  }
};

onBeforeUnmount(() => {
  if (curtainTimer) {
    window.clearTimeout(curtainTimer);
  }
});
</script>

<template>
  <div class="app-root">
    <Landing v-if="!showNextSection" @complete="handleLandingComplete" />
    <NextSection v-else />
    <div
      class="white-curtain"
      :class="{
        'white-curtain--hold': curtainPhase === 'hold',
        'white-curtain--fade': curtainPhase === 'fade',
        'white-curtain--no-transition': curtainSkipTransition,
      }"
      :style="{ '--curtain-duration': `${CURTAIN_FADE_DURATION}ms` }"
      @transitionend="handleCurtainTransitionEnd"
    ></div>
  </div>
</template>

<style scoped>
.app-root {
  position: relative;
}

.white-curtain {
  position: fixed;
  inset: 0;
  background: #fff;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--curtain-duration, 1.4s) cubic-bezier(0.2, 0.8, 0.2, 1);
  z-index: 30;
}

.white-curtain--hold {
  opacity: 1;
}

.white-curtain--fade {
  opacity: 0;
}

.white-curtain--no-transition {
  transition: none !important;
}
</style>
