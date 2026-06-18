'use strict';

/**
 * Voice — WebRTC full-mesh audio between players at a table.
 *
 * Each participant holds one RTCPeerConnection per other participant. Audio is
 * peer-to-peer; the server only relays SDP/ICE (same signaling shape as the
 * cameraFeed project). To avoid "glare" (both sides offering at once), the peer
 * with the lexicographically smaller id is always the offerer.
 */
const Voice = (() => {
  let send = null; // function(obj) -> sends a message to the server
  let myId = null;
  let iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  let localStream = null;
  let enabled = false;
  let muted = false;
  const peers = new Map(); // peerId -> { pc, audioEl }
  let onChange = () => {};

  function configure(opts) {
    send = opts.send;
    myId = opts.myId;
    if (opts.iceServers && opts.iceServers.length) iceServers = opts.iceServers;
    if (opts.onChange) onChange = opts.onChange;
  }

  function ensurePeer(peerId) {
    let entry = peers.get(peerId);
    if (entry) return entry;

    const pc = new RTCPeerConnection({ iceServers });
    if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'signal', to: peerId, data: { candidate: e.candidate } });
    };
    pc.ontrack = (e) => attachAudio(peerId, e.streams[0]);
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        // leave cleanup to explicit voice-left; transient disconnects may recover
      }
      onChange();
    };

    entry = { pc, audioEl: null };
    peers.set(peerId, entry);
    return entry;
  }

  async function makeOffer(peerId) {
    const { pc } = ensurePeer(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'signal', to: peerId, data: { sdp: pc.localDescription } });
  }

  function attachAudio(peerId, stream) {
    const entry = ensurePeer(peerId);
    if (!entry.audioEl) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.playsInline = true;
      document.getElementById('audio-sinks').appendChild(el);
      entry.audioEl = el;
    }
    entry.audioEl.srcObject = stream;
    entry.audioEl.play().catch(() => {});
  }

  function dropPeer(peerId) {
    const entry = peers.get(peerId);
    if (!entry) return;
    try { entry.pc.close(); } catch {}
    if (entry.audioEl) entry.audioEl.remove();
    peers.delete(peerId);
    onChange();
  }

  // ---- signaling handlers (called by app.js) --------------------------------

  function onPeers(list) {
    // Existing voice participants — connect to each; smaller id offers.
    for (const p of list) {
      ensurePeer(p.id);
      if (myId < p.id) makeOffer(p.id);
    }
  }
  function onJoined(p) {
    ensurePeer(p.id);
    if (myId < p.id) makeOffer(p.id);
  }
  function onLeft(id) { dropPeer(id); }

  async function onSignal(from, data) {
    const { pc } = ensurePeer(from);
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send({ type: 'signal', to: from, data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        await pc.addIceCandidate(data.candidate);
      }
    } catch (e) {
      console.warn('voice signal error', e);
    }
  }

  // ---- public controls ------------------------------------------------------

  async function enable() {
    if (enabled) return true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      alert('Could not access microphone: ' + e.message);
      return false;
    }
    enabled = true;
    muted = false;
    // Add local tracks to any pre-existing peer connections.
    for (const { pc } of peers.values()) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    send({ type: 'voice', on: true });
    onChange();
    return true;
  }

  function disable() {
    if (!enabled) return;
    enabled = false;
    send({ type: 'voice', on: false });
    for (const id of [...peers.keys()]) dropPeer(id);
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    onChange();
  }

  function toggleMute() {
    if (!enabled || !localStream) return false;
    muted = !muted;
    localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    onChange();
    return muted;
  }

  return {
    configure, onPeers, onJoined, onLeft, onSignal, enable, disable, toggleMute,
    isEnabled: () => enabled,
    isMuted: () => muted,
    peerCount: () => peers.size,
    states: () => [...peers.values()].map((p) => p.pc.connectionState),
  };
})();
window.Voice = Voice; // expose for the console / tests
