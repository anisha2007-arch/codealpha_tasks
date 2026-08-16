// A shared sketch pad. Strokes travel over the peer data channels, so the
// drawing never reaches the server.
const Whiteboard = (() => {
  const COLOURS = ['#e8ecf1', '#ffd166', '#7ee0b8', '#ff8fa3', '#8ab6ff'];

  // Every stroke is labelled with where it came from and a running number, so
  // a replayed snapshot can be merged with what has arrived live instead of
  // one having to be thrown away.
  const ORIGIN = Math.random().toString(36).slice(2, 10);
  let counter = 0;

  let canvas = null;
  let ctx = null;
  let drawing = false;
  let last = null;
  let colour = COLOURS[0];
  let width = 3;
  const history = [];
  const seen = new Set();

  function init(canvasEl, paletteEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);

    canvas.addEventListener('pointerdown', begin);
    canvas.addEventListener('pointermove', extend);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointerleave', end);

    paletteEl.innerHTML = COLOURS
      .map((c, i) => `<button class="swatch ${i === 0 ? 'on' : ''}" style="--swatch:${c}" data-colour="${c}"></button>`)
      .join('');
    paletteEl.addEventListener('click', (event) => {
      const button = event.target.closest('[data-colour]');
      if (!button) return;
      colour = button.dataset.colour;
      paletteEl.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s === button));
    });
  }

  // Coordinates travel as fractions of the canvas, so a stroke lands in the
  // same place on a differently sized window.
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  }

  function begin(event) {
    canvas.setPointerCapture(event.pointerId);
    drawing = true;
    last = point(event);
  }

  function extend(event) {
    if (!drawing) return;
    const next = point(event);
    const stroke = { id: `${ORIGIN}-${counter += 1}`, from: last, to: next, colour, width };
    remember(stroke);
    paint(stroke);
    Peers.broadcast({ kind: 'stroke', stroke });
    last = next;
  }

  function end() {
    drawing = false;
    last = null;
  }

  // Strokes that predate this client have no id of their own only if they came
  // from an older build; fall back to their shape so the set still works.
  function keyFor(stroke) {
    if (stroke.id) return stroke.id;
    return `${stroke.from.x},${stroke.from.y},${stroke.to.x},${stroke.to.y},${stroke.colour},${stroke.width}`;
  }

  function remember(stroke) {
    const key = keyFor(stroke);
    if (seen.has(key)) return false;
    seen.add(key);
    history.push(stroke);
    return true;
  }

  function paint({ from, to, colour: strokeColour, width: strokeWidth }) {
    ctx.strokeStyle = strokeColour;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x * canvas.width, from.y * canvas.height);
    ctx.lineTo(to.x * canvas.width, to.y * canvas.height);
    ctx.stroke();
  }

  function receive(stroke) {
    if (remember(stroke)) paint(stroke);
  }

  function clear(broadcast = true) {
    history.length = 0;
    seen.clear();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (broadcast) Peers.broadcast({ kind: 'board-clear' });
  }

  // Newcomers ask for the board; whoever is holding strokes replies with them.
  function snapshot() {
    return history.slice();
  }

  // A reply arrives a round trip after the request, and live strokes are not
  // held back while it is in flight, so by the time it lands there is almost
  // always something on the board already. Bailing out on that — which is what
  // this used to do — threw away every replay: a newcomer could end a call
  // with 85 strokes against the sharer's 208. Merge instead, and put the
  // replayed strokes underneath, since they came first.
  function restore(strokes) {
    if (!Array.isArray(strokes) || !strokes.length) return;

    const fresh = strokes.filter((stroke) => !seen.has(keyFor(stroke)));
    if (!fresh.length) return;

    fresh.forEach((stroke) => seen.add(keyFor(stroke)));
    history.unshift(...fresh);
    repaint();
  }

  function repaint() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    history.forEach(paint);
  }

  // The board starts inside a hidden panel, where clientWidth is 0, so this
  // has to run again once the panel is actually on screen.
  function resize() {
    if (!canvas || !canvas.clientWidth) return;
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    repaint();
  }

  return { init, receive, clear, snapshot, restore, resize };
})();
