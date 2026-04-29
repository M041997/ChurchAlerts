function buildWavDataUrl(
  sampleFn: (t: number) => number,
  duration: number
): string {
  const sampleRate = 44100;
  const samples = Math.floor(sampleRate * duration);
  const data = new Uint8Array(44 + samples * 2);
  const view = new DataView(data.buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples * 2, true);

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const sample = Math.max(-1, Math.min(1, sampleFn(t)));
    view.setInt16(44 + i * 2, sample * 0x7fff, true);
  }

  let binary = "";
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  const base64 =
    typeof btoa !== "undefined"
      ? btoa(binary)
      : Buffer.from(binary, "binary").toString("base64");
  return `data:audio/wav;base64,${base64}`;
}

let _siren: string | null = null;
let _allClear: string | null = null;
let _chatPing: string | null = null;

export function sirenUrl(): string {
  return (_siren ??= buildWavDataUrl((t) => {
    const cycle = 0.5;
    const freq = t % cycle < cycle / 2 ? 950 : 650;
    const env = Math.min(1, t * 6) * Math.min(1, (2.0 - t) * 6);
    return Math.sin(2 * Math.PI * freq * t) * env * 0.6;
  }, 2.0));
}

export function allClearUrl(): string {
  return (_allClear ??= buildWavDataUrl((t) => {
    const tone = 0.2;
    const gap = 0.06;
    if (t < tone) {
      const env = Math.min(1, t * 20) * Math.min(1, (tone - t) * 20);
      return Math.sin(2 * Math.PI * 660 * t) * env * 0.5;
    }
    if (t > tone + gap && t < tone * 2 + gap) {
      const local = t - tone - gap;
      const env = Math.min(1, local * 20) * Math.min(1, (tone - local) * 20);
      return Math.sin(2 * Math.PI * 880 * t) * env * 0.5;
    }
    return 0;
  }, 0.46));
}

export function chatPingUrl(): string {
  return (_chatPing ??= buildWavDataUrl((t) => {
    const env = Math.min(1, t * 40) * Math.min(1, (0.12 - t) * 40);
    return Math.sin(2 * Math.PI * 540 * t) * env * 0.18;
  }, 0.12));
}

export function play(url: string): void {
  if (typeof window === "undefined") return;
  try {
    const audio = new Audio(url);
    audio.play().catch(() => {});
  } catch {
    /* ignored — browser blocked autoplay */
  }
}
