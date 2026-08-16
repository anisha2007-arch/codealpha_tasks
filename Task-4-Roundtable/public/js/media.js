// Owns the local camera and microphone, and the swap to a shared screen.
const Media = (() => {
  let stream = null;
  let cameraTrack = null;
  let screenTrack = null;
  let videoEnabled = true;
  let onShareChange = () => {};

  function init(handlers = {}) {
    onShareChange = handlers.onShareChange || onShareChange;
  }

  async function start() {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    cameraTrack = stream.getVideoTracks()[0];
    return stream;
  }

  function localStream() {
    return stream;
  }

  // What is actually going out over the peer connections right now. Everything
  // that touches outbound video asks for this rather than reaching into the
  // camera stream: a peer created while a screen share is running has to be
  // given the screen, and the mute button has to mute what is being sent.
  function outboundVideoTrack() {
    return screenTrack || cameraTrack;
  }

  function toggleAudio() {
    const track = stream.getAudioTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    return track.enabled;
  }

  // Applied to both tracks, so the flag on the track being sent, the flag on
  // the camera, and the local preview all say the same thing. Flipping only
  // the camera track is why the button could read "Camera off" while the
  // screen capture kept streaming to everybody.
  function toggleVideo() {
    videoEnabled = !videoEnabled;
    applyVideoEnabled();
    return videoEnabled;
  }

  function applyVideoEnabled() {
    if (cameraTrack) cameraTrack.enabled = videoEnabled;
    if (screenTrack) screenTrack.enabled = videoEnabled;
  }

  function videoIsOn() {
    return videoEnabled;
  }

  function sharingScreen() {
    return Boolean(screenTrack);
  }

  // Swaps the outgoing video track on every peer connection, so the other side
  // does not have to renegotiate. Stopping the share from the browser's own
  // control bar puts the camera back.
  async function startScreenShare(onEnded) {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
    screenTrack = display.getVideoTracks()[0];
    applyVideoEnabled();

    await Peers.replaceVideoTrack(screenTrack);
    screenTrack.addEventListener('ended', () => stopScreenShare().then(onEnded));
    onShareChange(true);
    return screenTrack;
  }

  async function stopScreenShare() {
    if (!screenTrack) return cameraTrack;
    screenTrack.stop();
    screenTrack = null;
    applyVideoEnabled();
    await Peers.replaceVideoTrack(cameraTrack);
    onShareChange(false);
    return cameraTrack;
  }

  function stop() {
    if (screenTrack) screenTrack.stop();
    if (stream) stream.getTracks().forEach((track) => track.stop());
  }

  return {
    init, start, localStream, outboundVideoTrack, toggleAudio, toggleVideo,
    videoIsOn, startScreenShare, stopScreenShare, sharingScreen, stop,
  };
})();
