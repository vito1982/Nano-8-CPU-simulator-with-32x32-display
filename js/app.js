/*
 * UI-слой Nano-8.
 * Классические скрипты, без сборки и внешних зависимостей.
 */
(function () {
  "use strict";

  const ISA = window.NanoISA;
  const EXAMPLES = window.NanoExamples;

  const $ = (id) => document.getElementById(id);

  const DISPLAY = {
    X_ADDR: 0xf8,
    Y_ADDR: 0xf9,
    CTRL_ADDR: 0xfa,
    WIDTH: 32,
    HEIGHT: 32
  };

  const IO_LABELS = new Map([
    [DISPLAY.X_ADDR, "DISP_X"],
    [DISPLAY.Y_ADDR, "DISP_Y"],
    [DISPLAY.CTRL_ADDR, "DISP_CTRL"]
  ]);

  const PHASES = {
    FETCH: { label: "ВЫБОРКА", code: "FETCH" },
    DECODE: { label: "ДЕКОД", code: "DECODE" },
    EXECUTE: { label: "ИСПОЛНЕНИЕ", code: "EXECUTE" },
    HALTED: { label: "ОСТАНОВ", code: "HALT" },
    FAULT: { label: "ОШИБКА", code: "FAULT" }
  };

  // На высоких скоростях выполняем несколько тактов за один кадр,
  // чтобы длинные программы не выполнялись минутами.
  const SPEED_LEVELS = [
    { delay: 600, steps: 1 },
    { delay: 430, steps: 1 },
    { delay: 300, steps: 1 },
    { delay: 210, steps: 1 },
    { delay: 140, steps: 2 },
    { delay: 90, steps: 3 },
    { delay: 58, steps: 4 },
    { delay: 36, steps: 6 },
    { delay: 20, steps: 10 },
    { delay: 12, steps: 20 }
  ];

  const state = {
    cpu: null,
    program: null,
    dirty: true,
    running: false,
    timer: null,
    speed: 7,
    lastAssemblyFailed: false,
    errorLines: new Set(),
    selectedMemory: null,
    hoverMemory: null,
    toastTimer: null,
    codeAddresses: new Set(),
    symbolByAddress: new Map(),
    nodes: [],
    buses: [],
    cycleSteps: [],
    memoryCells: [],
    displayContext: null,
    lastDisplayVersion: -1
  };

  const el = {};

  function init() {
    [
      "statusBadge", "statusText", "guideBtn", "examplesSelect",
      "lineNumbers", "highlight", "source", "editorMessage",
      "editorStatus", "editorStatusText", "sizeInfo", "assembleBtn",
      "phasePill", "cycleCount", "currentInstr", "instructionAddress",
      "svgPc", "svgSp", "svgMar", "svgMdr", "svgIr", "svgPhase",
      "svgOut", "svgA", "svgFlagZ", "svgFlagC", "svgFlagN",
      "stepNo", "stepTitle", "stepDetail", "stepBtn", "instrBtn",
      "runBtn", "runIcon", "runLabel", "resetBtn", "speed", "speedLabel",
      "cyclePhase",
      "regA", "regABin", "regPC", "regPCBin", "regSP", "regSPBin",
      "regMAR", "regMDR", "regIR", "flagZ", "flagC", "flagN",
      "clearOutputBtn", "outputLast", "outputLastDec", "outputAscii",
      "outputStream", "memoryGrid", "memoryDetail", "guideDialog",
      "guideCloseBtn", "isaTableBody", "toast", "datapath",
      "displayCanvas", "displayEmpty", "pixelCount", "dispX", "dispY",
      "dispCtrl", "clearDisplayBtn"
    ].forEach((id) => { el[id] = $(id); });

    state.nodes = Array.from(document.querySelectorAll("#datapath [data-node]"));
    state.buses = Array.from(document.querySelectorAll("#datapath [data-bus]"));
    state.cycleSteps = Array.from(document.querySelectorAll("[data-cycle]"));
    state.memoryCells = [];
    state.displayContext = el.displayCanvas.getContext("2d");

    buildExampleSelect();
    buildIsaTable();
    buildMemoryGrid();
    bindEvents();
    applySpeed();

    el.source.value = EXAMPLES[0].source;
    updateEditorView();
    assembleProgram({ silent: true });
  }

  /* ------------------------------------------------------------------ */
  /*  Программа и ассемблер                                             */
  /* ------------------------------------------------------------------ */

  function assembleProgram(options = {}) {
    stopRunning(false);

    const result = NanoAssembler.assemble(el.source.value);
    state.errorLines = new Set(result.errors.map((error) => error.line));

    if (!result.ok) {
      state.lastAssemblyFailed = true;
      state.dirty = true;
      const lines = result.errors.slice(0, 5).map((error) =>
        "Строка " + error.line + ": " + error.message
      );
      if (result.errors.length > 5) lines.push("…и ещё " + (result.errors.length - 5));
      setEditorMessage(lines.join("\n"), "error");
      setEditorStatus("Ошибка сборки — исправьте код", "error");
      el.sizeInfo.textContent = "—";
      updateEditorView();
      renderAll();
      return false;
    }

    state.program = result;
    state.cpu = new NanoCPU(result.ram, result.start);
    state.dirty = false;
    state.lastAssemblyFailed = false;
    state.selectedMemory = result.start;
    state.hoverMemory = null;
    state.lastDisplayVersion = -1;

    state.codeAddresses = new Set();
    for (const entry of result.listing) {
      for (let i = 0; i < entry.bytes.length; i++) {
        state.codeAddresses.add((entry.address + i) & 0xff);
      }
    }

    state.symbolByAddress = new Map();
    for (const [name, value] of Object.entries(result.symbols)) {
      if (result.equates[name] !== undefined) continue;
      if (!state.symbolByAddress.has(value)) state.symbolByAddress.set(value, name);
    }

    el.sizeInfo.textContent = result.size + " / 256 Б";
    const symbolCount = Object.keys(result.symbols).length;
    setEditorStatus(
      "Собрано · " + result.size + " Б" + (symbolCount ? " · " + symbolCount + " мет." : ""),
      "ok"
    );

    if (result.warnings.length) {
      const lines = result.warnings.slice(0, 4).map((warning) =>
        "Строка " + warning.line + ": " + warning.message
      );
      setEditorMessage(lines.join("\n"), "warn");
    } else {
      setEditorMessage("", "");
    }

    state.errorLines.clear();
    updateEditorView();
    renderAll();

    if (!options.silent) {
      showToast("Собрано: " + result.size + " байт. Процессор сброшен.");
    }

    return true;
  }

  function resetCPU(options = {}) {
    stopRunning(false);
    if (!state.program) return;

    state.cpu = new NanoCPU(state.program.ram, state.program.start);
    state.selectedMemory = state.program.start;
    state.hoverMemory = null;
    state.lastDisplayVersion = -1;

    if (options.render !== false) renderAll();
    if (!options.silent) showToast("Процессор сброшен в начало программы.");
  }

  /* ------------------------------------------------------------------ */
  /*  Выполнение                                                        */
  /* ------------------------------------------------------------------ */

  function canExecute() {
    return !!state.program && !!state.cpu && !state.dirty && !state.lastAssemblyFailed;
  }

  function stepOnce() {
    if (!canExecute()) {
      showToast("Сначала соберите программу.", true);
      return;
    }
    if (state.running) stopRunning(false);

    if (state.cpu.halted || state.cpu.fault) {
      showToast("Процессор остановлен. Нажмите «Сброс» или «Заново».");
      return;
    }

    state.cpu.step();
    renderAll();

    if (state.cpu.fault) {
      showToast(state.cpu.fault.message, true);
    } else if (state.cpu.halted) {
      showToast("HLT: программа завершена.");
    }
  }

  function stepInstruction() {
    if (!canExecute()) {
      showToast("Сначала соберите программу.", true);
      return;
    }
    if (state.running) stopRunning(false);

    if (state.cpu.halted || state.cpu.fault) {
      showToast("Процессор остановлен. Нажмите «Сброс» или «Заново».");
      return;
    }

    let guard = 0;
    do {
      state.cpu.step();
      guard++;
    } while (
      !state.cpu.halted &&
      !state.cpu.fault &&
      !(state.cpu.phase === "FETCH" && state.cpu.microIndex === 0) &&
      guard < 128
    );

    renderAll();

    if (state.cpu.fault) {
      showToast(state.cpu.fault.message, true);
    } else if (state.cpu.halted) {
      showToast("HLT: программа завершена.");
    }
  }

  function toggleRun() {
    if (state.running) {
      stopRunning(true);
      return;
    }
    startRun();
  }

  function startRun() {
    if (!canExecute()) {
      showToast("Сначала соберите программу.", true);
      return;
    }

    if (state.cpu.halted || state.cpu.fault) {
      resetCPU({ silent: true, render: false });
    }

    state.running = true;
    renderAll();

    clearTimeout(state.timer);
    state.timer = setTimeout(runTick, 24);
  }

  function runTick() {
    if (!state.running || !state.cpu) return;

    const level = SPEED_LEVELS[state.speed - 1];

    for (let i = 0; i < level.steps; i++) {
      if (state.cpu.halted || state.cpu.fault) break;
      state.cpu.step();
    }

    if (state.cpu.halted || state.cpu.fault) {
      state.running = false;
      state.timer = null;
      renderAll();
      if (state.cpu.fault) showToast(state.cpu.fault.message, true);
      else showToast("HLT: программа завершена за " + state.cpu.cycles + " тактов.");
      return;
    }

    renderAll();
    state.timer = setTimeout(runTick, level.delay);
  }

  function stopRunning(render) {
    state.running = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (render) renderAll();
  }

  /* ------------------------------------------------------------------ */
  /*  Отрисовка                                                         */
  /* ------------------------------------------------------------------ */

  function renderAll() {
    renderStatus();
    renderControls();

    if (!state.cpu) return;

    renderMachine();
    renderRegisters();
    renderDatapath();
    renderDisplay();
    renderOutput();
    renderMemory();
  }

  function getStatusInfo() {
    if (state.lastAssemblyFailed) return { kind: "error", text: "Ошибка сборки" };
    if (state.cpu && state.cpu.fault) return { kind: "error", text: "Ошибка выполнения" };
    if (state.cpu && state.cpu.halted) return { kind: "halted", text: "Остановлен" };
    if (state.running) return { kind: "running", text: "Выполняется" };
    if (state.dirty) return { kind: "dirty", text: "Нужна сборка" };
    if (state.cpu && state.cpu.lastStep) return { kind: "ready", text: "Пауза" };
    return { kind: "ready", text: "Готов" };
  }

  function renderStatus() {
    const info = getStatusInfo();
    el.statusBadge.dataset.kind = info.kind;
    el.statusText.textContent = info.text;
  }

  function getPhase() {
    if (!state.cpu) return "FETCH";
    if (state.cpu.fault) return "FAULT";
    if (state.cpu.halted) return "HALTED";
    return state.cpu.phase;
  }

  function renderMachine() {
    const cpu = state.cpu;
    const phase = getPhase();
    const phaseInfo = PHASES[phase] || PHASES.FETCH;

    el.phasePill.dataset.phase = phase;
    el.phasePill.textContent = phaseInfo.label;
    el.cycleCount.textContent = String(cpu.cycles);

    el.cyclePhase.textContent = phaseInfo.code;
    for (const cycleStep of state.cycleSteps) {
      cycleStep.classList.toggle(
        "active",
        (phase === "FETCH" || phase === "DECODE" || phase === "EXECUTE") &&
        cycleStep.dataset.cycle === phase
      );
    }

    let instruction = null;

    if (phase === "HALTED" && cpu.lastInstruction) {
      instruction = disassembleAt(cpu.lastInstruction.startPC);
    } else if (phase === "FAULT") {
      instruction = {
        text: "??? $" + ISA.hex8(cpu.IR),
        address: cpu.instructionStart
      };
    } else if (cpu.current) {
      instruction = disassembleAt(cpu.current.startPC);
    } else if (cpu.phase === "FETCH" && cpu.microIndex > 0) {
      instruction = disassembleAt(cpu.instructionStart);
    } else {
      instruction = disassembleAt(cpu.PC);
    }

    el.currentInstr.textContent = instruction ? instruction.text : "—";
    el.instructionAddress.textContent = "@ $" + ISA.hex8(instruction ? instruction.address : cpu.PC);

    const step = cpu.lastStep;

    if (step) {
      el.stepNo.textContent = step.t === "—" ? "—" : "T" + step.t;
      el.stepTitle.textContent = step.title;
      el.stepDetail.textContent = step.detail;
    } else if (phase === "HALTED") {
      el.stepNo.textContent = "HLT";
      el.stepTitle.textContent = "Программа завершена";
      el.stepDetail.textContent = "HLT остановил процессор. Нажмите «Сброс» или «Заново».";
    } else {
      el.stepNo.textContent = "—";
      el.stepTitle.textContent = "Готов к выполнению";
      el.stepDetail.textContent = "Нажмите «Такт», чтобы выполнить один шаг, или «Запуск», чтобы увидеть программу целиком.";
    }
  }

  function renderRegisters() {
    const cpu = state.cpu;

    el.regA.textContent = "$" + ISA.hex8(cpu.A);
    el.regPC.textContent = "$" + ISA.hex8(cpu.PC);
    el.regSP.textContent = "$" + ISA.hex8(cpu.SP);
    el.regABin.textContent = formatBits(cpu.A);
    el.regPCBin.textContent = formatBits(cpu.PC);
    el.regSPBin.textContent = formatBits(cpu.SP);
    el.regMAR.textContent = "$" + ISA.hex8(cpu.MAR);
    el.regMDR.textContent = "$" + ISA.hex8(cpu.MDR);
    el.regIR.textContent = "$" + ISA.hex8(cpu.IR);

    setFlag(el.flagZ, cpu.flags.Z);
    setFlag(el.flagC, cpu.flags.C);
    setFlag(el.flagN, cpu.flags.N);
  }

  function setFlag(node, value) {
    node.dataset.on = value ? "1" : "0";
    const valueNode = node.querySelector("i");
    if (valueNode) valueNode.textContent = value ? "1" : "0";
  }

  function renderDatapath() {
    const cpu = state.cpu;
    const phase = getPhase();
    const activeNodes = new Set(cpu.lastStep ? cpu.lastStep.nodes || [] : []);
    const activeBuses = new Set(cpu.lastStep ? cpu.lastStep.buses || [] : []);

    for (const node of state.nodes) {
      node.classList.toggle("active", activeNodes.has(node.dataset.node));
    }

    for (const bus of state.buses) {
      bus.classList.toggle("active", activeBuses.has(bus.dataset.bus));
    }

    el.svgPc.textContent = "$" + ISA.hex8(cpu.PC);
    el.svgSp.textContent = "$" + ISA.hex8(cpu.SP);
    el.svgMar.textContent = "$" + ISA.hex8(cpu.MAR);
    el.svgMdr.textContent = "$" + ISA.hex8(cpu.MDR);
    el.svgA.textContent = "$" + ISA.hex8(cpu.A);

    const decoded = ISA.BY_CODE[cpu.IR];
    el.svgIr.textContent = "$" + ISA.hex8(cpu.IR) + (decoded ? " " + decoded.mnemonic : "");
    el.svgPhase.textContent = (PHASES[phase] || PHASES.FETCH).code;

    const lastOutput = cpu.output.length ? cpu.output[cpu.output.length - 1] : null;
    el.svgOut.textContent = lastOutput ? "$" + lastOutput.hex : "—";

    for (const flag of ["Z", "C", "N"]) {
      const svgText = el["svgFlag" + flag];
      svgText.textContent = flag + "=" + cpu.flags[flag];

      const pill = svgText.parentElement;
      if (pill) pill.classList.toggle("on", cpu.flags[flag] === 1);
    }
  }

  function renderDisplay() {
    const cpu = state.cpu;
    const display = cpu.display;

    if (state.lastDisplayVersion !== display.version) {
      drawDisplay(display);
      state.lastDisplayVersion = display.version;
    }

    el.pixelCount.textContent = display.count + " px";
    el.displayEmpty.hidden = display.count > 0;
    el.dispX.textContent = "$" + ISA.hex8(display.x);
    el.dispY.textContent = "$" + ISA.hex8(display.y);
    el.dispCtrl.textContent = "$" + ISA.hex8(cpu.ram[DISPLAY.CTRL_ADDR]);
    el.clearDisplayBtn.disabled = display.count === 0;
  }

  function drawDisplay(display) {
    const context = state.displayContext;
    if (!context) return;

    context.clearRect(0, 0, DISPLAY.WIDTH, DISPLAY.HEIGHT);
    context.fillStyle = "#050d0b";
    context.fillRect(0, 0, DISPLAY.WIDTH, DISPLAY.HEIGHT);
    context.fillStyle = "#74f0ca";

    for (let y = 0; y < DISPLAY.HEIGHT; y++) {
      for (let x = 0; x < DISPLAY.WIDTH; x++) {
        const index = y * 4 + (x >> 3);
        if ((display.ram[index] >> (x & 7)) & 1) {
          context.fillRect(x, y, 1, 1);
        }
      }
    }
  }

  function renderOutput() {
    const output = state.cpu.output;
    const last = output.length ? output[output.length - 1] : null;

    el.outputLast.textContent = last ? "$" + last.hex : "—";
    el.outputLastDec.textContent = last ? String(last.value) : "нет вывода";

    const ascii = output
      .map((entry) => (entry.char ? entry.char : "·"))
      .join("");
    const asciiPreview = ascii.length > 54 ? "…" + ascii.slice(-54) : ascii;
    el.outputAscii.textContent = asciiPreview || "—";
    el.outputAscii.title = ascii;

    if (!output.length) {
      el.outputStream.innerHTML = '<span class="empty-note">OUT отправит сюда байт из аккумулятора</span>';
      return;
    }

    const tail = output.slice(-30);
    let html = output.length > 30 ? '<span class="empty-note">…</span>' : "";

    for (const entry of tail) {
      html += '<span class="out-chip" title="цикл ' + entry.cycle + '">' +
        "<b>" + entry.value + "</b><i>$" + entry.hex + "</i></span>";
    }

    el.outputStream.innerHTML = html;
    el.outputStream.scrollTop = el.outputStream.scrollHeight;
  }

  function renderControls() {
    const cpu = state.cpu;
    const blocked = !canExecute();
    const stopped = !cpu || cpu.halted || !!cpu.fault;

    el.stepBtn.disabled = blocked || state.running || stopped;
    el.instrBtn.disabled = blocked || state.running || stopped;
    el.runBtn.disabled = blocked;
    el.resetBtn.disabled = !state.program || state.dirty || state.lastAssemblyFailed;
    el.clearOutputBtn.disabled = !cpu || cpu.output.length === 0;
    el.clearDisplayBtn.disabled = !cpu || cpu.display.count === 0;

    if (state.running) {
      el.runIcon.textContent = "❚❚";
      el.runLabel.textContent = "Пауза";
    } else if (stopped) {
      el.runIcon.textContent = "↻";
      el.runLabel.textContent = "Заново";
    } else {
      el.runIcon.textContent = "▶";
      el.runLabel.textContent = "Запуск";
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Память                                                            */
  /* ------------------------------------------------------------------ */

  function buildMemoryGrid() {
    const fragment = document.createDocumentFragment();
    const corner = document.createElement("span");
    corner.className = "mem-col";
    corner.textContent = "";
    fragment.appendChild(corner);

    for (let col = 0; col < 16; col++) {
      const head = document.createElement("span");
      head.className = "mem-col";
      head.textContent = col.toString(16).toUpperCase();
      fragment.appendChild(head);
    }

    for (let row = 0; row < 16; row++) {
      const rowLabel = document.createElement("span");
      rowLabel.className = "mem-row";
      rowLabel.textContent = (row * 16).toString(16).toUpperCase().padStart(2, "0");
      fragment.appendChild(rowLabel);

      for (let col = 0; col < 16; col++) {
        const address = row * 16 + col;
        const cell = document.createElement("div");
        cell.className = "mem-cell";
        cell.dataset.address = String(address);
        cell.setAttribute("role", "gridcell");
        cell.textContent = "00";
        fragment.appendChild(cell);
        state.memoryCells[address] = cell;
      }
    }

    el.memoryGrid.appendChild(fragment);
  }

  function renderMemory() {
    const cpu = state.cpu;
    if (!cpu) return;

    const lastWrite = cpu.lastWrite ? cpu.lastWrite.addr : null;

    for (let address = 0; address < 256; address++) {
      const value = cpu.ram[address];
      const cell = state.memoryCells[address];
      if (!cell) continue;

      cell.textContent = ISA.hex8(value);

      let classes = "mem-cell";
      if (value !== 0) classes += " nonzero";
      if (state.codeAddresses.has(address)) classes += " program";
      if (IO_LABELS.has(address)) classes += " io";
      if (address === cpu.PC) classes += " pc";
      if (address === cpu.SP) classes += " sp";
      if (address === cpu.MAR) classes += " mar";
      if (address === lastWrite) classes += " write";
      if (address === state.selectedMemory) classes += " selected";
      cell.className = classes;
    }

    updateMemoryDetail();
  }

  function updateMemoryDetail() {
    const cpu = state.cpu;
    if (!cpu) return;

    const address = state.hoverMemory != null
      ? state.hoverMemory
      : (state.selectedMemory != null ? state.selectedMemory : cpu.PC);
    const value = cpu.ram[address];
    const parts = [];

    if (address === cpu.PC) parts.push("PC");
    if (address === cpu.SP) parts.push("SP");
    if (address === cpu.MAR) parts.push("MAR");
    if (cpu.lastWrite && address === cpu.lastWrite.addr) parts.push("последняя запись");

    const ioLabel = IO_LABELS.get(address);
    const label = state.symbolByAddress.get(address);
    const segment = findSegment(address);

    if (ioLabel) parts.push("<span class=\"mem-tag\">I/O · " + ioLabel + "</span>");
    if (label) parts.push("<span class=\"mem-tag\">" + escapeHtml(label) + "</span>");
    if (segment) parts.push(segment.kind === "instruction" ? "команда" : "данные");

    el.memoryDetail.innerHTML =
      "<b>$" + ISA.hex8(address) + "</b> = <b>$" + ISA.hex8(value) + "</b>" +
      " · " + value + " · " + formatBits(value) +
      (parts.length ? " · " + parts.join(" · ") : "");
  }

  function findSegment(address) {
    if (!state.program) return null;
    return state.program.listing.find((entry) =>
      address >= entry.address && address < entry.address + entry.bytes.length
    ) || null;
  }

  /* ------------------------------------------------------------------ */
  /*  Редактор                                                          */
  /* ------------------------------------------------------------------ */

  function updateEditorView() {
    const text = el.source.value;
    const lines = text.split("\n");

    el.highlight.innerHTML = lines.map(highlightLine).join("\n") || "&#8203;";
    el.lineNumbers.innerHTML = lines.map((_, index) => {
      const line = index + 1;
      return '<span' + (state.errorLines.has(line) ? ' class="error"' : "") + ">" + line + "</span>";
    }).join("");

    syncEditorScroll();
  }

  function syncEditorScroll() {
    el.highlight.scrollTop = el.source.scrollTop;
    el.highlight.scrollLeft = el.source.scrollLeft;
    el.lineNumbers.scrollTop = el.source.scrollTop;
  }

  function highlightLine(line) {
    let html = "";
    let i = 0;

    while (i < line.length) {
      const ch = line[i];

      if (ch === ";" || (ch === "/" && line[i + 1] === "/")) {
        html += token("comment", line.slice(i));
        break;
      }

      if (ch === '"' || ch === "'") {
        let j = i + 1;
        let escaped = false;
        while (j < line.length) {
          const inner = line[j];
          if (escaped) escaped = false;
          else if (inner === "\\") escaped = true;
          else if (inner === ch) {
            j++;
            break;
          }
          j++;
        }
        html += token("string", line.slice(i, j));
        i = j;
        continue;
      }

      if (/\s/.test(ch)) {
        html += ch;
        i++;
        continue;
      }

      if (/[A-Za-z_]/.test(ch)) {
        let j = i + 1;
        while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++;
        const word = line.slice(i, j);
        let k = j;
        while (k < line.length && /[ \t]/.test(line[k])) k++;

        if (line[k] === ":") {
          html += token("label", word);
        } else if (ISA.MNEMONICS[word.toUpperCase()]) {
          html += token("mnemonic", word);
        } else {
          html += token("ident", word);
        }

        i = j;
        continue;
      }

      if (ch === "." && /[A-Za-z]/.test(line[i + 1] || "")) {
        let j = i + 1;
        while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++;
        html += token("directive", line.slice(i, j));
        i = j;
        continue;
      }

      if (ch === "$" || ch === "%" || /[0-9]/.test(ch)) {
        let j = i + 1;

        if (ch === "$") {
          while (j < line.length && /[0-9a-fA-F]/.test(line[j])) j++;
        } else if (ch === "%") {
          while (j < line.length && /[01]/.test(line[j])) j++;
        } else if (ch === "0" && /[xXbB]/.test(line[i + 1] || "")) {
          j = i + 2;
          const hex = /[xX]/.test(line[i + 1]);
          while (j < line.length && (hex ? /[0-9a-fA-F]/ : /[01]/).test(line[j])) j++;
        } else {
          while (j < line.length && /[0-9]/.test(line[j])) j++;
        }

        html += token("number", line.slice(i, j));
        i = j;
        continue;
      }

      html += escapeHtml(ch);
      i++;
    }

    return html || "&#8203;";
  }

  function token(kind, text) {
    return '<span class="tok-' + kind + '">' + escapeHtml(text) + "</span>";
  }

  function setEditorMessage(text, kind) {
    if (!text) {
      el.editorMessage.hidden = true;
      el.editorMessage.textContent = "";
      el.editorMessage.className = "editor-message";
      return;
    }

    el.editorMessage.hidden = false;
    el.editorMessage.className = "editor-message " + kind;
    el.editorMessage.textContent = text;
  }

  function setEditorStatus(text, variant) {
    el.editorStatus.className = "editor-status" + (variant ? " is-" + variant : "");
    el.editorStatusText.textContent = text;
  }

  /* ------------------------------------------------------------------ */
  /*  Система команд                                                    */
  /* ------------------------------------------------------------------ */

  function buildIsaTable() {
    el.isaTableBody.innerHTML = ISA.HELP.map((row) =>
      "<tr>" +
        "<td>" + escapeHtml(row.mnemonic) + "</td>" +
        "<td>" + escapeHtml(row.operands) + "</td>" +
        "<td>" + escapeHtml(row.effect) + "</td>" +
        "<td>" + escapeHtml(row.flags) + "</td>" +
      "</tr>"
    ).join("");
  }

  /* ------------------------------------------------------------------ */
  /*  События                                                           */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    el.assembleBtn.addEventListener("click", () => assembleProgram());

    el.source.addEventListener("input", () => {
      if (state.running) stopRunning(false);

      state.dirty = !state.program || el.source.value !== state.program.source;
      state.lastAssemblyFailed = false;
      state.errorLines.clear();
      setEditorMessage("", "");
      updateEditorView();

      if (state.dirty) {
        setEditorStatus("Изменено — соберите заново", "dirty");
        el.sizeInfo.textContent = "—";
      } else if (state.program) {
        setEditorStatus("Совпадает с собранной программой", "ok");
        el.sizeInfo.textContent = state.program.size + " / 256 Б";
      }

      renderStatus();
      renderControls();
    });

    el.source.addEventListener("scroll", syncEditorScroll);

    el.source.addEventListener("keydown", (event) => {
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        const start = el.source.selectionStart;
        const end = el.source.selectionEnd;
        el.source.setRangeText("    ", start, end, "end");
        el.source.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    el.examplesSelect.addEventListener("change", () => {
      const example = EXAMPLES.find((item) => item.id === el.examplesSelect.value);
      if (!example) return;

      stopRunning(false);
      el.source.value = example.source;
      el.examplesSelect.title = example.note;
      state.dirty = true;
      state.lastAssemblyFailed = false;
      state.errorLines.clear();
      updateEditorView();
      assembleProgram({ silent: true });
      showToast("Пример: " + example.title);
    });

    el.stepBtn.addEventListener("click", stepOnce);
    el.instrBtn.addEventListener("click", stepInstruction);
    el.runBtn.addEventListener("click", toggleRun);
    el.resetBtn.addEventListener("click", () => resetCPU());

    el.speed.addEventListener("input", () => {
      state.speed = Number(el.speed.value);
      applySpeed();
    });

    el.clearOutputBtn.addEventListener("click", () => {
      if (!state.cpu) return;
      state.cpu.output = [];
      renderOutput();
      renderDatapath();
      renderControls();
    });

    el.clearDisplayBtn.addEventListener("click", () => {
      if (!state.cpu) return;
      state.cpu.clearDisplay();
      renderDisplay();
      renderControls();
    });

    el.memoryGrid.addEventListener("pointerover", (event) => {
      const cell = event.target.closest(".mem-cell");
      if (!cell) return;
      state.hoverMemory = Number(cell.dataset.address);
      updateMemoryDetail();
    });

    el.memoryGrid.addEventListener("pointerleave", () => {
      state.hoverMemory = null;
      updateMemoryDetail();
    });

    el.memoryGrid.addEventListener("click", (event) => {
      const cell = event.target.closest(".mem-cell");
      if (!cell) return;
      state.selectedMemory = Number(cell.dataset.address);
      renderMemory();
    });

    el.guideBtn.addEventListener("click", () => {
      if (state.running) stopRunning(true);
      el.guideDialog.showModal();
    });
    el.guideCloseBtn.addEventListener("click", () => el.guideDialog.close());

    el.guideDialog.addEventListener("click", (event) => {
      const rect = el.guideDialog.getBoundingClientRect();
      const outside = event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom;
      if (outside) el.guideDialog.close();
    });

    document.addEventListener("keydown", (event) => {
      if (el.guideDialog.open) return;

      if (event.ctrlKey && event.key === "Enter") {
        event.preventDefault();
        assembleProgram();
        return;
      }

      if (event.key === "F8") {
        event.preventDefault();
        stepOnce();
      } else if (event.key === "F9") {
        event.preventDefault();
        toggleRun();
      }
    });
  }

  function applySpeed() {
    const percent = ((state.speed - 1) / 9) * 100;
    el.speed.style.setProperty("--fill", percent + "%");
    el.speedLabel.textContent = state.speed + "×";
  }

  /* ------------------------------------------------------------------ */
  /*  Утилиты                                                           */
  /* ------------------------------------------------------------------ */

  function disassembleAt(address) {
    return ISA.disassemble(state.cpu.ram, address, state.program ? state.program.symbols : null);
  }

  function buildExampleSelect() {
    el.examplesSelect.innerHTML = EXAMPLES.map((example) =>
      '<option value="' + escapeHtml(example.id) + '">' + escapeHtml(example.title) + "</option>"
    ).join("");
    el.examplesSelect.value = EXAMPLES[0].id;
    el.examplesSelect.title = EXAMPLES[0].note;
  }

  function formatBits(value) {
    return (value & 0xff).toString(2).padStart(8, "0").replace(/(.{4})(.{4})/, "$1 $2");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showToast(message, isError) {
    clearTimeout(state.toastTimer);
    el.toast.textContent = message;
    el.toast.className = "toast" + (isError ? " error" : "");
    el.toast.hidden = false;

    state.toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, isError ? 3600 : 2500);
  }

  init();
})();
