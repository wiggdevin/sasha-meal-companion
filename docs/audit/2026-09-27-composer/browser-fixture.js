// Synthetic SpeechRecognition transport for rendered interaction checks.
// Installed with Page.addScriptToEvaluateOnNewDocument in the isolated local harness.
// This proves rendered UI behavior, not microphone hardware/provider transcription quality.
window.__composerSpeech = { sessions: [], denyNext: false, deferEnd: false };
window.SpeechRecognition = class {
  constructor() { window.__composerSpeech.sessions.push(this); }
  start() {
    if (window.__composerSpeech.denyNext) {
      window.__composerSpeech.denyNext = false;
      queueMicrotask(() => this.onerror?.({ error: "not-allowed" }));
    } else queueMicrotask(() => this.onstart?.());
  }
  stop() { if (!window.__composerSpeech.deferEnd) queueMicrotask(() => this.onend?.()); }
  abort() { this.aborted = true; }
  emit(text, final = true) {
    const result = [{ transcript: text }];
    result.isFinal = final;
    this.onresult?.({ resultIndex: 0, results: [result] });
  }
};
