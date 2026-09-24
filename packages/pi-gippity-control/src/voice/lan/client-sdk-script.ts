import { LAN_AUDIO_DEVICES_SCRIPT } from "./audio-devices-script.ts";
import { LAN_VOICE_AUDIO_WORKLET } from "./audio-worklet.ts";
import { LAN_VOICE_MICROPHONE_BUFFER_WORKLET } from "./microphone-buffer-worklet.ts";

const AUDIO_WORKLET_SOURCE = JSON.stringify(LAN_VOICE_AUDIO_WORKLET);
const MICROPHONE_WORKLET_SOURCE = JSON.stringify(
	LAN_VOICE_MICROPHONE_BUFFER_WORKLET,
);

export const LAN_REMOTE_CLIENT_SCRIPT = String.raw`
(function (global) {
  'use strict';
  // The access token arrives in the URL fragment, which is never sent to the
  // server. Keep it in this origin's sessionStorage and remove it from the URL.
  const token = (() => {
    const key = 'gippity-token';
    try {
      const fragment = new URLSearchParams(global.location.hash.slice(1));
      const fromUrl = fragment.get('token');
      if (fromUrl) {
        global.sessionStorage.setItem(key, fromUrl);
        fragment.delete('token');
        const rest = fragment.toString();
        global.history.replaceState(global.history.state, '', global.location.pathname + global.location.search + (rest ? '#' + rest : ''));
      }
      return global.sessionStorage.getItem(key) || '';
    } catch { return ''; }
  })();
  const authHeaders = (headers) => ({ ...headers, authorization:'Bearer ' + token });
  const postJson = (path, body, keepalive = false) =>
    fetch(path, { method:'POST', keepalive, headers:authHeaders({'content-type':'application/json'}), body:JSON.stringify(body) });
  const audioWorkletSource = ${AUDIO_WORKLET_SOURCE};
  const microphoneWorkletSource = ${MICROPHONE_WORKLET_SOURCE};
  ${LAN_AUDIO_DEVICES_SCRIPT}

  function id() {
    return global.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // Browser-direct media: this page holds the call's RTCPeerConnection to
  // OpenAI. The host signals the call and exchanges data-channel messages
  // through the page's audio socket; audio never crosses the host.
  function createDirectCall({ stream, send, devices }) {
    const pc = new RTCPeerConnection();
    const audio = new Audio(); audio.autoplay = true;
    let closed = false, levelTimer, receiver;
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
    // Microphone level: RMS of the live input (0 while muted).
    let meter;
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser(); analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      meter = { context, read() {
        if (!stream.getAudioTracks().some((track) => track.enabled)) return 0;
        analyser.getFloatTimeDomainData(samples);
        let sum = 0; for (const value of samples) sum += value * value;
        return Math.sqrt(sum / samples.length);
      } };
    } catch {}
    // About 14 samples a second of mic and call output levels.
    levelTimer = setInterval(() => {
      const output = receiver?.getSynchronizationSources?.()[0]?.audioLevel ?? 0;
      const input = meter?.read() ?? 0;
      call.level = output; call.inputLevel = input;
      send({ type:'rtc.level', input, output });
    }, 70);
    const channel = pc.createDataChannel('oai-events');
    channel.onopen = () => send({ type:'rtc.state', state:'ready' });
    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message && typeof message === 'object' && !Array.isArray(message)) send({ type:'rtc.data', message });
      } catch {}
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (['connecting', 'connected', 'disconnected', 'failed', 'closed'].includes(state)) send({ type:'rtc.state', state });
    };
    pc.ontrack = (event) => {
      audio.srcObject = event.streams[0] || new MediaStream([event.track]);
      void devices.attach(audio); void audio.play().catch(() => {});
      receiver = event.receiver;
    };
    const call = {
      pc, audio, level:0, inputLevel:0,
      async offer() {
        await pc.setLocalDescription(await pc.createOffer());
        if (pc.iceGatheringState !== 'complete')
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 2000);
            pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } });
          });
        return pc.localDescription.sdp;
      },
      answer(sdp) { return pc.setRemoteDescription({ type:'answer', sdp }); },
      send(message) {
        if (channel.readyState === 'open') channel.send(JSON.stringify(message));
        else send({ type:'rtc.error', message:'DataChannel is not opened' });
      },
      setSpeakerSuppressed(suppressed) { audio.muted = Boolean(suppressed); },
      close() {
        if (closed) return; closed = true;
        clearInterval(levelTimer); devices.detach(audio);
        void meter?.context.close().catch(() => {});
        audio.pause(); audio.srcObject = null;
        try { channel.close(); } catch {}
        pc.close();
      },
    };
    return call;
  }

  async function createRealtimeAudio(stream) {
    const context = new AudioContext({ latencyHint:'interactive' });
    let source, microphoneBuffer, processor;
    let inputEpoch = 0, speakerSuppressed = false;
    try {
      const microphoneUrl = URL.createObjectURL(new Blob([microphoneWorkletSource], { type:'text/javascript' }));
      const audioUrl = URL.createObjectURL(new Blob([audioWorkletSource], { type:'text/javascript' }));
      try { await Promise.all([context.audioWorklet.addModule(microphoneUrl), context.audioWorklet.addModule(audioUrl)]); }
      finally { URL.revokeObjectURL(microphoneUrl); URL.revokeObjectURL(audioUrl); }
      await context.resume();
      if (context.state !== 'running') throw new Error('Browser audio did not start. Check its media permissions.');
      source = context.createMediaStreamSource(stream);
      microphoneBuffer = new AudioWorkletNode(context, 'pi-lan-microphone-buffer', { channelCount:1, channelCountMode:'explicit', outputChannelCount:[1] });
      processor = new AudioWorkletNode(context, 'pi-lan-voice', { numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[1] });
      source.connect(microphoneBuffer);
      microphoneBuffer.connect(processor);
      processor.connect(context.destination);
      return {
        context, processor,
        acceptCapture(value) { return value?.type === 'capture' && value.epoch === inputEpoch && value.pcm instanceof ArrayBuffer ? value.pcm : undefined; },
        releaseInput() { microphoneBuffer.port.postMessage({ type:'release' }); },
        setInputMuted(muted) {
          inputEpoch += 1;
          const command = { type:'input_muted', muted:Boolean(muted), epoch:inputEpoch };
          microphoneBuffer.port.postMessage(command);
          processor.port.postMessage(command);
        },
        setSpeakerSuppressed(suppressed) {
          const next = Boolean(suppressed);
          if (speakerSuppressed === next) return;
          speakerSuppressed = next;
          processor.port.postMessage({ type:'speaker_suppressed', suppressed:next });
        },
        play(pcm) { if (!speakerSuppressed) processor.port.postMessage(pcm, [pcm]); },
        close() {
          processor.disconnect(); microphoneBuffer.disconnect(); source.disconnect();
          void context.close().catch(() => {});
        },
      };
    } catch (error) {
      processor?.disconnect(); microphoneBuffer?.disconnect(); source?.disconnect();
      await context.close().catch(() => {});
      throw error;
    }
  }

  function createAudio(client, assertOpen) {
    let socket, stream, context, source, processor, realtimeAudio, directCall;
    let mode = 'conversation';
    let active = false, muted = false, inputTooQuiet = false, busy = false, finishing = false, starting = false;
    let generation = 0;
    let state = 'idle', detail = '';

    const snapshot = () => ({ type:'audio', mode, active, busy, muted, inputTooQuiet, state, detail });
    const publish = (nextState, nextDetail = '') => {
      if (nextState) state = nextState;
      detail = nextDetail;
      client._emit('audio', snapshot());
    };
    const closeHardware = () => {
      directCall?.close(); directCall = undefined;
      const currentRealtime = realtimeAudio; realtimeAudio = undefined;
      if (currentRealtime) currentRealtime.close();
      else { processor?.disconnect(); source?.disconnect(); void context?.close().catch(() => {}); }
      if (context) client.devices.detach(context);
      processor = undefined; source = undefined; context = undefined;
      stream?.getTracks().forEach((track) => track.stop()); stream = undefined;
    };
    const setMuted = (next, notify = true, synchronize = false) => {
      if (notify && (!active || mode !== 'conversation')) return;
      const nextMuted = Boolean(next);
      if (muted !== nextMuted || synchronize) realtimeAudio?.setInputMuted(nextMuted);
      muted = nextMuted;
      stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
      if (notify && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type:'mute', muted }));
	  if (!active) { client._emit('audio', snapshot()); return; }
      publish(muted ? 'muted' : 'listening', muted ? 'Voice remains connected' : (inputTooQuiet ? 'Microphone level is too low' : ''));
    };
    const finishStop = (notify, reason) => {
      active = false; muted = false; inputTooQuiet = false; finishing = false; busy = false;
      const current = socket; socket = undefined;
      if (notify && current?.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type:'release' }));
      if (notify) void client._post('/api/stop', { terminateConversation: mode === 'conversation' }).catch(() => {});
      current?.close(1000, reason);
      closeHardware();
      publish(reason === 'replaced' ? 'replaced' : 'idle', reason === 'replaced' ? 'Moved to another device' : '');
    };
    const stop = (draftSnapshot, notify = true, reason = 'user') => {
      generation += 1;
	  if (finishing) {
		finishing = false; busy = false;
		const current = socket; socket = undefined;
		if (current?.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type:'cancel' }));
		current?.close(1000, 'dictation-cancelled'); closeHardware(); publish('idle');
		return;
	  }
      if (notify && active && mode === 'dictation' && socket?.readyState === WebSocket.OPEN) {
        const draft = draftSnapshot ?? client.draft;
        active = false; busy = true; finishing = true;
        socket.send(JSON.stringify({
          type:'finish', draft:draft.text, revision:draft.revision,
          selectionStart:draft.selectionStart ?? draft.text.length,
          selectionEnd:draft.selectionEnd ?? draft.text.length,
        }));
        closeHardware();
        publish('transcribing');
        return;
      }
      finishStop(notify, reason);
    };
    const receive = (current, event) => {
      if (socket !== current) return;
      if (event.data instanceof ArrayBuffer) { realtimeAudio?.play(event.data); return; }
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'stop') { finishStop(false, message.reason || 'server'); return; }
        if (message.type === 'mute') setMuted(message.muted, false);
        if (message.type === 'speaker_suppressed') { realtimeAudio?.setSpeakerSuppressed(message.suppressed); directCall?.setSpeakerSuppressed(message.suppressed); }
        if (message.type === 'rtc.offer.request' && stream) {
          directCall?.close();
          const reply = (value) => { if (socket === current && current.readyState === WebSocket.OPEN) current.send(JSON.stringify(value)); };
          const call = directCall = createDirectCall({ stream, send:reply, devices:client.devices });
          void call.offer().then((sdp) => { if (directCall === call) reply({ type:'rtc.offer', sdp }); },
            (error) => reply({ type:'rtc.error', message:error instanceof Error ? error.message : String(error) }));
          return;
        }
        if (message.type === 'rtc.answer') { void directCall?.answer(message.sdp).catch((error) => current.send(JSON.stringify({ type:'rtc.error', message:String(error?.message || error) }))); return; }
        if (message.type === 'rtc.send') { directCall?.send(message.message); return; }
        if (message.type === 'rtc.close') { directCall?.close(); directCall = undefined; return; }
        if (message.type === 'active') {
          active = true; busy = false; finishing = false;
          if (mode === 'conversation') {
            inputTooQuiet = false;
            const initialMuted = typeof message.muted === 'boolean' ? message.muted : muted;
            setMuted(initialMuted, false, initialMuted);
            realtimeAudio?.setSpeakerSuppressed(Boolean(message.speakerSuppressed));
            if (!initialMuted) realtimeAudio?.releaseInput();
          }
          publish(muted ? 'muted' : (mode === 'dictation' ? 'recording' : 'listening'));
        }
        if (message.type === 'dictation.complete') {
          finishing = false; busy = false; active = false;
          socket = undefined; current.close(1000, 'dictation-complete');
		  publish('idle'); client._emit('dictation.complete', message);
        }
        if (message.type === 'error') { finishStop(false, 'upstream-error'); publish('error', message.message || 'Voice failed'); }
      } catch {}
    };
    const start = async (nextMode = mode) => {
      if (nextMode !== 'conversation' && nextMode !== 'dictation') throw new Error('Audio mode must be conversation or dictation');
      if (starting || busy || active || socket) return;
      mode = nextMode;
      if (mode === 'dictation') muted = false;
      const currentGeneration = ++generation;
      starting = true; busy = true; publish('opening', 'Allow microphone access if asked.');
      try {
        if (!global.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access needs HTTPS and certificate acceptance.');
        if (!global.AudioWorkletNode) throw new Error('This browser does not support the required low-latency audio runtime.');
        const microphone = { channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true };
        await client.devices.refresh();
        stream = await navigator.mediaDevices.getUserMedia({ audio:client.devices.inputConstraints(microphone) });
        // Device labels appear only after permission; reopen if the chosen microphone was not open.
        await client.devices.refresh();
        if (currentGeneration !== generation) { closeHardware(); return; }
        if (client.devices.needsReopen(stream)) {
          stream.getTracks().forEach((track) => track.stop());
          stream = await navigator.mediaDevices.getUserMedia({ audio:client.devices.inputConstraints(microphone) });
          if (currentGeneration !== generation) { closeHardware(); return; }
        }
        if (mode === 'conversation' && client.media === 'direct') {
          // The call's media is set up when the host asks for an offer.
        } else if (mode === 'conversation') {
          realtimeAudio = await createRealtimeAudio(stream);
          context = realtimeAudio.context; processor = realtimeAudio.processor;
          await client.devices.attach(context);
        } else {
          context = new AudioContext({ latencyHint:'interactive' });
          await client.devices.attach(context);
          const workletUrl = URL.createObjectURL(new Blob([audioWorkletSource], { type:'text/javascript' }));
          try { await context.audioWorklet.addModule(workletUrl); }
          finally { URL.revokeObjectURL(workletUrl); }
          if (currentGeneration !== generation) { closeHardware(); return; }
          await context.resume();
          if (context.state !== 'running') throw new Error('Browser audio did not start. Check its media permissions.');
          source = context.createMediaStreamSource(stream);
          processor = new AudioWorkletNode(context, 'pi-lan-voice', { numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[1] });
          source.connect(processor); processor.connect(context.destination);
        }
        if (currentGeneration !== generation) { closeHardware(); return; }
        const current = new WebSocket('wss://' + location.host + '/api/audio?client=' + encodeURIComponent(client.clientId), ['gippity.v1', 'gippity.token.' + token]);
        current.binaryType = 'arraybuffer'; socket = current;
        const timer = setTimeout(() => {
          if (socket !== current || current.readyState !== WebSocket.CONNECTING) return;
          finishStop(false, 'connect-timeout'); publish('error', 'Connection timed out.');
        }, 10000);
        if (processor) processor.port.onmessage = (event) => {
          const pcm = realtimeAudio
            ? realtimeAudio.acceptCapture(event.data)
            : event.data?.type === 'capture' && event.data.epoch === 0 && event.data.pcm instanceof ArrayBuffer ? event.data.pcm : undefined;
          if (pcm && active && !muted && socket === current && current.readyState === WebSocket.OPEN && current.bufferedAmount < 65536) current.send(pcm);
        };
        current.onopen = () => {
          if (socket !== current || !stream) return;
          clearTimeout(timer); current.send(JSON.stringify({ type:'start', mode })); publish('connecting');
        };
        current.onmessage = (event) => receive(current, event);
        current.onclose = (event) => {
          clearTimeout(timer);
          if (socket !== current) return;
          const detail = event.reason || 'Voice connection closed unexpectedly (' + event.code + ').';
          finishStop(false, 'connection-closed'); publish('error', detail);
        };
      } catch (error) {
        if (currentGeneration !== generation) return;
        finishStop(false, 'start-error'); publish('error', error instanceof Error ? error.message : String(error));
      } finally {
        starting = false;
        if (currentGeneration === generation && !socket) busy = false;
        client._emit('audio', snapshot());
      }
    };
    const serverCommand = (command) => {
      if (command.type === 'stop') finishStop(false, command.reason || 'server');
      if (command.type === 'error' && (active || busy || socket)) { finishStop(false, 'server-error'); publish('error', command.message); }
      if (command.type === 'mute' && mode === 'conversation') setMuted(command.muted, false);
      if (command.type === 'status' && busy && !active) publish(command.status === 'summarizing…' ? 'summarizing' : 'connecting');
      if (command.type === 'microphone') { inputTooQuiet = command.state === 'too-quiet'; if (active && !muted) publish('listening', inputTooQuiet ? 'Microphone level is too low' : ''); }
    };
    return {
      start(...args) { assertOpen(); return start(...args); },
      stop(...args) { assertOpen(); return stop(...args); },
      setMuted(...args) { assertOpen(); return setMuted(...args); },
      get state() { return snapshot(); },
      _serverCommand: serverCommand,
      /** Browser-direct call stats (RTCStatsReport), for diagnostics. */
      _callStats() { return directCall?.pc.getStats(); },
      /** Output level 0..1 of the direct call, for visualizers. */
      get level() { return directCall?.level ?? 0; },
      _pagehide() {
        stream?.getTracks().forEach((track) => track.stop());
		if (finishing && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type:'cancel' }));
		else if (active) void postJson('/api/stop', { clientId:client.clientId }, true).catch(() => {});
      },
	  _close() { if (finishing) stop(); else { generation += 1; finishStop(true, 'client-closed'); } },
    };
  }

  function connect(options = {}) {
    const clientId = options.clientId || id();
    const listeners = new Map();
    let closed = false, events, rpcId = 0;
    let draft = { type:'draft', text:'', revision:-1 };
    let dirty = false, syncing = false, syncPromise, timer;
	let resolveInitialDraft;
	const initialDraft = new Promise((resolve) => { resolveInitialDraft = resolve; });
	const assertOpen = () => { if (closed) throw new Error('GipPity remote is closed'); };

    const emit = (type, value, wildcard = true) => {
      for (const listener of listeners.get(type) || []) { try { listener(value); } catch (error) { setTimeout(() => { throw error; }); } }
	  if (wildcard && type !== '*') for (const listener of listeners.get('*') || []) { try { listener(value); } catch (error) { setTimeout(() => { throw error; }); } }
    };
    const post = async (path, body) => {
      assertOpen();
      const response = await postJson(path, { clientId, ...body });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Pi rejected the request');
      return result;
    };
    const client = {
      clientId,
      _emit: emit,
      _post: post,
      get draft() { return { ...draft }; },
      on(type, listener) {
        assertOpen();
        if (typeof listener !== 'function') throw new Error('Event listener must be a function');
        let group = listeners.get(type); if (!group) { group = new Set(); listeners.set(type, group); }
        group.add(listener); return () => group.delete(listener);
      },
      async call(target, method, ...args) {
        const id = ++rpcId;
        const result = await post('/api/rpc', { id, target, method, args });
        if (!result.ok) {
          const error = new Error(result.error?.message || 'Pi RPC failed');
          if (result.error?.name) error.name = result.error.name;
          throw error;
        }
        return result.result;
      },
      setDraft(text) {
        assertOpen();
        if (typeof text !== 'string') throw new Error('Draft text must be a string');
        draft = { ...draft, text, local:true };
        dirty = true; emit('draft', { ...draft });
        clearTimeout(timer); timer = setTimeout(() => { void flush().catch(() => {}); }, 180);
      },
      flushDraft: () => flush(),
      async send(text) {
        if (typeof text === 'string' && text !== draft.text) client.setDraft(text);
        clearTimeout(timer);
        await flush();
        if (!draft.text.trim()) throw new Error('A message is required');
        await post('/api/send', { text:draft.text, revision:draft.revision });
      },
      close() {
        if (closed) return; clearTimeout(timer);
        client.audio._close(); closed = true; resolveInitialDraft();
        void postJson('/api/draft', { clientId, text:draft.text, revision:draft.revision }, true).catch(() => {});
		global.removeEventListener('pagehide', pagehide);
        global.navigator?.mediaDevices?.removeEventListener?.('devicechange', devicechange);
        events?.abort(); listeners.clear();
      },
    };
    const flush = async () => {
	  if (closed) throw new Error('GipPity remote is closed');
      if (syncing) return syncPromise;
	  if (!dirty) return true;
      syncing = true;
      syncPromise = (async () => {
		if (draft.revision < 0) await initialDraft;
		if (closed) throw new Error('GipPity remote is closed');
        while (dirty) {
		  if (closed) throw new Error('GipPity remote is closed');
          dirty = false;
          const text = draft.text;
          try {
            const result = await post('/api/draft', { text, revision:draft.revision });
            if (typeof result.revision === 'number') draft = { ...draft, revision:Math.max(draft.revision, result.revision) };
          } catch (error) {
            dirty = true; emit('error', { type:'error', source:'draft', message:error instanceof Error ? error.message : String(error) });
            throw error;
          }
        }
        return true;
      })();
      try { return await syncPromise; }
      finally { syncing = false; syncPromise = undefined; }
    };
    const applyDraft = (command) => {
      if (typeof command.text !== 'string' || typeof command.revision !== 'number' || command.revision < draft.revision) return;
	  if (draft.revision < 0 && dirty) {
		draft = { ...draft, revision:command.revision };
		resolveInitialDraft(); emit('draft', { ...draft }); return;
	  }
	  const reconnectSnapshot = !command.sourceClientId && !command.reason;
	  const preserveLocal = (dirty || syncing) && draft.text !== command.text && (reconnectSnapshot || (command.sourceClientId === clientId && (command.reason === 'update' || command.reason === 'sent')));
      draft = preserveLocal ? { ...draft, revision:command.revision } : { ...command };
	  if (!preserveLocal && command.sourceClientId !== clientId) { clearTimeout(timer); dirty = false; }
	  if (reconnectSnapshot && preserveLocal && dirty) { clearTimeout(timer); timer = setTimeout(() => { void flush().catch(() => {}); }, 180); }
	  resolveInitialDraft();
      emit('draft', { ...draft });
    };
    client.devices = createAudioDevices({
      mediaDevices:global.navigator?.mediaDevices,
      storage:(() => { try { return global.localStorage; } catch { return undefined; } })(),
      onChange:(value) => emit('devices', value),
    });
    const devicechange = () => { void client.devices.refresh(); };
    global.navigator?.mediaDevices?.addEventListener?.('devicechange', devicechange);
    void client.devices.refresh();
    client.audio = createAudio(client, assertOpen);
    const receiveEvent = (data) => {
      try {
        const command = JSON.parse(data);
        client.audio._serverCommand(command);
        if (command.type === 'audio.defaults') { client.devices.setDefaults(command); client.media = command.media === 'relay' ? 'relay' : 'direct'; }
        if (command.type === 'draft') applyDraft(command);
        else emit(command.type, command);
		if (command.type === 'pi.event') emit('pi:' + command.event, command.data, false);
      } catch {}
    };
    // Server-Sent Events over fetch, because EventSource cannot send the token.
    const readEvents = async () => {
      while (!closed) {
        const controller = new AbortController(); events = controller;
        try {
          const response = await fetch('/api/events?client=' + encodeURIComponent(clientId), { headers:authHeaders({ accept:'text/event-stream' }), cache:'no-store', signal:controller.signal });
          if (response.status === 401) {
            emit('error', { type:'error', source:'connection', message:'GipPity needs its access token. Open the URL that Pi shows.' });
            return;
          }
          if (!response.ok || !response.body) throw new Error('GipPity events failed');
          emit('connection', { type:'connection', state:'connected' });
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
              const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              let name = 'message'; const data = [];
              for (const line of block.split('\n')) {
                if (line.startsWith('event:')) name = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
              }
              if (name === 'message' && data.length) receiveEvent(data.join('\n'));
            }
          }
        } catch {}
        if (closed) return;
        emit('connection', { type:'connection', state:'reconnecting' });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
    void readEvents();
	const pagehide = () => { client.audio._pagehide(); clearTimeout(timer); void postJson('/api/draft', { clientId, text:draft.text, revision:draft.revision }, true).catch(() => {}); };
	global.addEventListener('pagehide', pagehide);
    return client;
  }

  global.GippityRemote = Object.freeze({ connect });
})(globalThis);
`;
