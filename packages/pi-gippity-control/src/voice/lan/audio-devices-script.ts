/**
 * Browser-side audio device selection, embedded in the hosted client script.
 * Devices are matched by label so a choice survives the per-origin device IDs
 * that browsers rotate. A choice made in the page is kept in localStorage; the
 * server config gives the default. A missing device warns and falls back to
 * the system default. macOS settings are never changed.
 */
export const LAN_AUDIO_DEVICES_SCRIPT = String.raw`
function createAudioDevices({ mediaDevices, storage, onChange }) {
  const kinds = { input:'audioinput', output:'audiooutput' };
  const storageKeys = { input:'gippity-audio-input', output:'gippity-audio-output' };
  const names = { input:'microphone', output:'speaker' };
  const defaults = { input:'', output:'' };
  let devices = [];
  let warnings = { input:'', output:'' };
  const sinks = new Set();

  const read = (kind) => {
    try { const value = storage?.getItem(storageKeys[kind]); if (value !== null && value !== undefined) return value; } catch {}
    return defaults[kind];
  };
  const preferred = (kind) => read(kind).trim();
  const isAlias = (device) => device.deviceId === 'default' || device.deviceId === 'communications';
  const labelled = (kind) => devices.filter((device) => device.kind === kinds[kind] && device.label);
  const match = (kind) => {
    const wanted = preferred(kind).toLowerCase();
    if (!wanted) return undefined;
    const candidates = labelled(kind).filter((device) => !isAlias(device));
    return candidates.find((device) => device.label.toLowerCase() === wanted)
      ?? candidates.find((device) => device.label.toLowerCase().includes(wanted));
  };
  const resolve = (kind) => {
    const wanted = preferred(kind);
    const device = match(kind);
    // Labels appear only after microphone permission; do not warn before that.
    const known = labelled(kind).length > 0;
    warnings[kind] = wanted && !device && known ? wanted + ' (' + names[kind] + ') is not available. Using the system default.' : '';
    return device;
  };
  const snapshot = () => ({
    type:'devices',
    inputs:labelled('input').filter((device) => !isAlias(device)).map((device) => device.label),
    outputs:labelled('output').filter((device) => !isAlias(device)).map((device) => device.label),
    input:preferred('input'), output:preferred('output'),
    warnings:[warnings.input, warnings.output].filter(Boolean),
  });
  const applySink = async (target) => {
    const wanted = preferred('output');
    const device = resolve('output');
    if (typeof target?.setSinkId !== 'function') {
      if (wanted) warnings.output = 'This browser cannot choose a speaker. Using the system default.';
      return;
    }
    try { await target.setSinkId(device ? device.deviceId : ''); }
    catch { warnings.output = (wanted || 'The speaker') + ' could not be used. Using the system default.'; await target.setSinkId('').catch(() => {}); }
  };
  const publish = () => onChange?.(snapshot());

  return {
    snapshot,
    setDefaults(next) {
      for (const kind of ['input', 'output'])
        if (typeof next?.[kind + 'Device'] === 'string') defaults[kind] = next[kind + 'Device'];
      publish();
    },
    async refresh() {
      try { devices = (await mediaDevices?.enumerateDevices?.()) ?? []; } catch { devices = []; }
      resolve('input'); resolve('output');
      for (const target of sinks) await applySink(target);
      publish();
    },
    select(kind, label) {
      if (!storageKeys[kind]) throw new Error('Unknown audio device kind');
      try { storage?.setItem(storageKeys[kind], typeof label === 'string' ? label : ''); } catch {}
      resolve(kind);
      const pending = kind === 'output' ? Promise.all([...sinks].map(applySink)) : Promise.resolve();
      return pending.then(() => publish());
    },
    /** getUserMedia audio constraints for the chosen microphone. */
    inputConstraints(base) {
      const device = resolve('input');
      return device ? { ...base, deviceId:{ exact:device.deviceId } } : base;
    },
    /** True when the open track is not the chosen microphone. */
    needsReopen(stream) {
      const device = resolve('input');
      const current = stream?.getAudioTracks?.()[0]?.getSettings?.().deviceId;
      return Boolean(device && current !== device.deviceId);
    },
    async attach(target) { sinks.add(target); await applySink(target); publish(); },
    detach(target) { sinks.delete(target); },
  };
}
`;
