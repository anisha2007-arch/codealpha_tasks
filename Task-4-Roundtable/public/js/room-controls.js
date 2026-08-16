// The control strip under the call: microphone, camera, screen share, the
// whiteboard panel, sending a file, copying the room link, and leaving.
//
// All of it is button wiring against Media, Whiteboard and Transfer, which is a
// different job from setting the call up, so it is out of room.js. It reports
// through the onStatus callback rather than touching the status line itself —
// room.js owns what that line says.
const RoomControls = (() => {
  const sharingEl = document.getElementById('sharing-note');
  const fileInput = document.getElementById('file');
  const camButton = document.getElementById('cam');

  let onStatus = () => {};

  function init(options) {
    onStatus = options.onStatus;

    toggle('mic', () => Media.toggleAudio(), 'Microphone on', 'Microphone off');
    document.getElementById('cam').addEventListener('click', () => {
      Media.toggleVideo();
      refreshCamButton();
    });

    document.getElementById('share').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      try {
        if (Media.sharingScreen()) {
          await Media.stopScreenShare();
          button.classList.remove('on');
          button.textContent = 'Share screen';
        } else {
          await Media.startScreenShare(() => {
            button.classList.remove('on');
            button.textContent = 'Share screen';
            refreshCamButton();
          });
          button.classList.add('on');
          button.textContent = 'Stop sharing';
        }
        refreshCamButton();
      } catch {
        onStatus('Screen sharing was cancelled.', 'ok');
      }
    });

    document.getElementById('board-toggle').addEventListener('click', (event) => {
      const panel = document.getElementById('board-panel');
      panel.hidden = !panel.hidden;
      event.currentTarget.classList.toggle('on', !panel.hidden);
      if (!panel.hidden) Whiteboard.resize();
    });

    document.getElementById('board-clear').addEventListener('click', () => Whiteboard.clear());

    fileInput.addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (!file) return;

      // Locked for the length of the send: chunks are matched to a transfer by
      // sender, not by id, so two in flight from one browser would interleave.
      fileInput.disabled = true;
      try {
        await Transfer.send(file);
      } catch (err) {
        onStatus(err.message, 'bad');
      } finally {
        fileInput.disabled = false;
        event.target.value = '';
      }
    });

    document.getElementById('copy-link').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        onStatus('Room link copied.', 'ok');
      } catch {
        onStatus(`Copy this link to invite people: ${location.href}`, 'ok');
      }
    });

    document.getElementById('leave').addEventListener('click', () => {
      Media.stop();
      window.location.href = '/';
    });

    window.addEventListener('beforeunload', () => Media.stop());
    refreshCamButton();
  }

  // Passed to Media.init as onShareChange, so the banner follows the share
  // rather than the button that started it.
  function showSharing(sharing) {
    sharingEl.hidden = !sharing;
  }

  // While a screen share is running, this button controls the screen capture,
  // because that is what is going out. Saying "Camera" then would be a lie.
  function refreshCamButton() {
    const on = Media.videoIsOn();
    const noun = Media.sharingScreen() ? 'Video' : 'Camera';
    camButton.classList.toggle('off', !on);
    camButton.textContent = `${noun} ${on ? 'on' : 'off'}`;
  }

  function toggle(id, action, onLabel, offLabel) {
    document.getElementById(id).addEventListener('click', (event) => {
      const enabled = action();
      event.currentTarget.classList.toggle('off', !enabled);
      event.currentTarget.textContent = enabled ? onLabel : offLabel;
    });
  }

  return { init, showSharing };
})();
