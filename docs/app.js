/* The hero demo: a journal and an outbox, behaving the way the library does.
 *
 * Pending ops have no seq, because nothing has confirmed them. Only the log
 * assigns one, and only then is it safe to forget the local copy. That's the
 * whole library, and it's the whole widget. */

(() => {
  const $ = (id) => document.getElementById(id);

  const logPane = $("log");
  const logEmpty = $("log-empty");
  const outboxPane = $("outbox");
  const outboxEmpty = $("outbox-empty");
  const outboxCount = $("outbox-count");
  const netBtn = $("net");
  const netLabel = $("net-label");
  const writeBtn = $("write");

  if (!logPane) return;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Real ops from the app this was extracted from — a lifting log. */
  const POOL = [
    ["workout.started", "leg day"],
    ["set.logged", "squat 5×5 @ 100kg"],
    ["set.logged", "squat 5×5 @ 102.5kg"],
    ["note.added", "felt heavy on the last rep"],
    ["set.logged", "romanian deadlift 3×8 @ 70kg"],
    ["workout.finished", "42 min"],
    ["workout.started", "push day"],
    ["set.logged", "bench 5×5 @ 60kg"],
    ["set.logged", "overhead press 5×5 @ 37.5kg"],
    ["note.added", "shoulder twinge — drop next week"],
  ];

  let online = true;
  let seq = 0;
  let cursor = 0;
  let acked = [];
  let pending = [];
  let flushing = false;
  let scripted = true;
  let timers = [];

  const sleep = (ms) =>
    new Promise((r) => timers.push(setTimeout(r, reduced ? 0 : ms)));

  const nextOp = () => POOL[cursor++ % POOL.length];

  function row(op) {
    const el = document.createElement("div");
    el.className = `op op--${op.state}`;
    el.innerHTML = `
      <span class="op__seq">${op.seq === null ? "·" : String(op.seq).padStart(3, "0")}</span>
      <span class="op__kind">${op.kind}</span>
      <span class="op__body">${op.body}</span>
      <span class="op__state">${op.state}</span>`;
    return el;
  }

  function render(entering) {
    logPane.replaceChildren();
    if (acked.length === 0) {
      logPane.append(logEmpty);
    } else {
      /* Only the tail is worth drawing — the mask fades the rest out anyway. */
      for (const op of acked.slice(-6)) {
        const el = row(op);
        if (entering === op.id) el.classList.add("op--flush");
        logPane.append(el);
      }
    }

    outboxPane.replaceChildren();
    if (pending.length === 0) {
      outboxPane.append(outboxEmpty);
    } else {
      for (const op of pending) {
        const el = row(op);
        if (entering === op.id) el.classList.add("op--enter");
        outboxPane.append(el);
      }
    }

    const n = pending.length;
    outboxCount.textContent = n === 0 ? "0 queued" : `${n} queued`;
  }

  let uid = 0;

  function write() {
    const [kind, body] = nextOp();
    const op = { id: ++uid, seq: null, kind, body, state: "pending" };
    pending.push(op);
    render(op.id);
    void flush();
  }

  /* An ack is the only thing that assigns a seq — and the only thing that lets
     the op leave the outbox. Offline, this does nothing at all. */
  async function flush() {
    if (!online || flushing || pending.length === 0) return;
    flushing = true;
    await sleep(420); // the round trip
    while (online && pending.length > 0) {
      const op = pending.shift();
      op.seq = ++seq;
      op.state = "acked";
      acked.push(op);
      render(op.id);
      await sleep(110);
    }
    flushing = false;
  }

  function setOnline(next) {
    online = next;
    netBtn.dataset.online = String(next);
    netBtn.setAttribute("aria-pressed", String(!next));
    netLabel.textContent = next ? "Online" : "Offline";
    if (next) void flush();
  }

  function takeOver() {
    if (!scripted) return;
    scripted = false;
    timers.forEach(clearTimeout);
    timers = [];
  }

  netBtn.addEventListener("click", () => {
    takeOver();
    setOnline(!online);
  });

  writeBtn.addEventListener("click", () => {
    takeOver();
    write();
  });

  /* An opening sequence that states the thesis without anyone clicking:
     writes land, the network drops, writes pile up, the network returns,
     the outbox drains. Any interaction cancels it. */
  async function intro() {
    if (reduced) {
      write();
      write();
      await flush();
      setOnline(false);
      write();
      return;
    }

    await sleep(700);
    if (!scripted) return;
    write();
    await sleep(1500);
    if (!scripted) return;
    write();
    await sleep(1800);
    if (!scripted) return;

    setOnline(false);
    await sleep(800);
    if (!scripted) return;
    write();
    await sleep(950);
    if (!scripted) return;
    write();
    await sleep(1100);
    if (!scripted) return;
    write();
    await sleep(2400);
    if (!scripted) return;

    setOnline(true);
  }

  render();

  /* Don't animate to an empty room. */
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        void intro();
      }
    },
    { threshold: 0.25 },
  );
  io.observe(logPane);

  /* Copy the install line. */
  const copy = $("copy");
  copy?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("install-cmd").textContent.trim());
      copy.dataset.copied = "true";
      copy.textContent = "Copied";
      setTimeout(() => {
        copy.dataset.copied = "false";
        copy.textContent = "Copy";
      }, 1600);
    } catch {
      /* Clipboard blocked — the text is right there to select. */
    }
  });
})();
