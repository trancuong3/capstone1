/** Created in the start gesture so sound is unlocked before mic permission.
 * Short, quiet tones share the visual countdown clock; no speech service. */
export function createCountdownSound() {
  let context: AudioContext | undefined;
  const stop = () => {
    if (context && context.state !== "closed")
      void context.close().catch(() => {});
    context = undefined;
  };
  try {
    if (typeof AudioContext !== "undefined") {
      context = new AudioContext();
      void context.resume().catch(() => {});
    }
  } catch {
    stop();
  }
  return {
    stop,
    play(step: number) {
      if (!context || context.state === "closed") return;
      try {
        const oscillator = context.createOscillator();
        const envelope = context.createGain();
        const now = context.currentTime;
        const duration = step === 0 ? 0.14 : 0.09;
        oscillator.frequency.setValueAtTime(step === 0 ? 880 : 520, now);
        envelope.gain.setValueAtTime(0, now);
        envelope.gain.linearRampToValueAtTime(0.08, now + 0.01);
        envelope.gain.linearRampToValueAtTime(0, now + duration);
        oscillator.connect(envelope);
        envelope.connect(context.destination);
        if (step === 0) oscillator.onended = stop;
        oscillator.start(now);
        oscillator.stop(now + duration);
      } catch {
        stop();
      }
    },
  };
}
