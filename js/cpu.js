/*
 * Ядро Nano-8.
 *
 * Один вызов step() — один такт (микрооперация). Команда состоит
 * из выборки, декодирования и одного-нескольких тактов исполнения.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./isa"));
  } else {
    root.NanoCPU = factory(root.NanoISA);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (ISA) {
  "use strict";

  const DISPLAY = Object.freeze({
    X_ADDR: 0xf8,
    Y_ADDR: 0xf9,
    CTRL_ADDR: 0xfa,
    WIDTH: 32,
    HEIGHT: 32,
    BYTES_PER_ROW: 4,
    VRAM_SIZE: 128,
    STACK_START: 0xf7
  });

  class NanoCPU {
    constructor(ram, start) {
      this.ram = new Uint8Array(256);
      this.reset(ram, start);
    }

    reset(ram, start) {
      if (ram) this.ram = Uint8Array.from(ram);
      else if (!this.ram) this.ram = new Uint8Array(256);

      this.start = (start == null ? 0 : start) & 0xff;
      this.PC = this.start;
      this.A = 0;
      this.SP = DISPLAY.STACK_START;
      this.IR = 0;
      this.MAR = 0;
      this.MDR = 0;

      this.flags = { Z: 0, C: 0, N: 0 };

      this.display = {
        ram: new Uint8Array(DISPLAY.VRAM_SIZE),
        x: 0,
        y: 0,
        count: 0,
        version: 0
      };

      this.phase = "FETCH";
      this.microIndex = 0;
      this.tState = 0;
      this.execProgram = [];
      this.current = null;
      this.lastInstruction = null;

      this.instructionStart = this.start;
      this.instructionStartCycle = 0;
      this.instructionCount = 0;
      this.cycles = 0;

      this.halted = false;
      this.fault = null;

      this.output = [];
      this.lastRead = null;
      this.lastWrite = null;
      this.lastDisplayEvent = null;
      this.lastStep = null;
      this.writeCount = 0;
    }

    load(ram, start) {
      this.reset(ram, start);
    }

    setZN(value) {
      value &= 0xff;
      this.flags.Z = value === 0 ? 1 : 0;
      this.flags.N = (value & 0x80) ? 1 : 0;
    }

    displayRegisterName(address) {
      if (address === DISPLAY.X_ADDR) return "DISP_X";
      if (address === DISPLAY.Y_ADDR) return "DISP_Y";
      if (address === DISPLAY.CTRL_ADDR) return "DISP_CTRL";
      return null;
    }

    getDisplayPixel(x, y) {
      x &= 31;
      y &= 31;
      const index = y * DISPLAY.BYTES_PER_ROW + (x >> 3);
      return (this.display.ram[index] >> (x & 7)) & 1;
    }

    setDisplayPixel(x, y, mode) {
      x &= 31;
      y &= 31;
      const index = y * DISPLAY.BYTES_PER_ROW + (x >> 3);
      const mask = 1 << (x & 7);
      const before = (this.display.ram[index] & mask) !== 0;
      const after = mode === 1 ? true : mode === 0 ? false : !before;

      if (before !== after) {
        if (after) this.display.count++;
        else this.display.count--;
        if (after) this.display.ram[index] |= mask;
        else this.display.ram[index] &= ~mask;
      }

      this.display.version++;
      return after;
    }

    clearDisplay() {
      this.display.ram.fill(0);
      this.display.count = 0;
      this.display.version++;
    }

    fillDisplayColumn(x, yStart) {
      for (let y = Math.max(0, yStart); y < DISPLAY.HEIGHT; y++) {
        this.setDisplayPixel(x, y, 1);
      }
    }

    applyDisplayCommand(command) {
      const x = this.display.x;
      const y = this.display.y;
      let action = null;

      if (command === 1) {
        this.setDisplayPixel(x, y, 1);
        action = "plot";
      } else if (command === 2) {
        this.clearDisplay();
        action = "clear";
      } else if (command === 3) {
        this.setDisplayPixel(x, y, 0);
        action = "erase";
      } else if (command === 4) {
        this.setDisplayPixel(x, y, -1);
        action = "invert";
      } else if (command === 5) {
        this.fillDisplayColumn(x, y);
        action = "vline";
      }

      return action ? { action, x, y, command } : null;
    }

    /*
     * Единая точка записи в память. Адреса $F8–$FA — memory-mapped
     * регистры дисплейного контроллера, а не обычная RAM.
     */
    writeMemory(address, value, meta) {
      const byte = value & 0xff;
      this.ram[address] = byte;

      let displayEvent = null;

      if (address === DISPLAY.X_ADDR) {
        this.display.x = byte & 31;
      } else if (address === DISPLAY.Y_ADDR) {
        this.display.y = byte & 31;
      } else if (address === DISPLAY.CTRL_ADDR) {
        displayEvent = this.applyDisplayCommand(byte);
      }

      this.lastWrite = {
        addr: address,
        value: byte,
        cycle: this.cycles + 1,
        ...(meta || {})
      };
      this.writeCount++;

      if (displayEvent) {
        this.lastDisplayEvent = {
          ...displayEvent,
          address,
          value: byte,
          cycle: this.cycles + 1
        };
      }

      return displayEvent;
    }

    _haltInfo() {
      return {
        phase: "HALTED",
        title: "Процессор остановлен",
        detail: "Команда HLT завершила программу. Сброс вернёт PC в начало.",
        nodes: ["cu"],
        buses: [],
        t: "—"
      };
    }

    _faultInfo() {
      return {
        phase: "FAULT",
        title: "Ошибка выполнения",
        detail: this.fault ? this.fault.message : "Неизвестная ошибка",
        nodes: ["cu", "ir"],
        buses: [],
        t: "—"
      };
    }

    step() {
      if (this.halted) return this._haltInfo();
      if (this.fault) return this._faultInfo();

      const tState = this.tState;
      let info;

      if (this.phase === "FETCH") info = this._fetch();
      else if (this.phase === "DECODE") info = this._decode();
      else if (this.phase === "EXECUTE") info = this._execute();
      else {
        this.fault = { message: "Процессор попал в неизвестное состояние: " + this.phase };
        return this._faultInfo();
      }

      this.cycles++;
      info.t = tState;
      info.cycle = this.cycles;
      this.lastStep = info;

      if (this.phase === "FETCH" && this.microIndex === 0) {
        this.tState = 0;
      } else {
        this.tState = tState + 1;
      }

      return info;
    }

    _fetch() {
      if (this.microIndex === 0) {
        this.MAR = this.PC;
        this.instructionStart = this.PC;
        this.instructionStartCycle = this.cycles;
        this.current = null;
        this.microIndex = 1;

        return {
          phase: "FETCH",
          title: "MAR ← PC",
          detail: "Адрес команды из счётчика PC попадает в регистр адреса памяти MAR.",
          nodes: ["pc", "mar"],
          buses: ["pc-mar"]
        };
      }

      if (this.microIndex === 1) {
        this.MDR = this.ram[this.MAR];
        this.lastRead = { addr: this.MAR, value: this.MDR, cycle: this.cycles + 1 };
        this.PC = (this.PC + 1) & 0xff;
        this.microIndex = 2;

        return {
          phase: "FETCH",
          title: "MDR ← RAM[MAR]; PC ← PC + 1",
          detail: "Память выдаёт байт команды в MDR. Счётчик PC заранее указывает на следующий байт.",
          nodes: ["mar", "ram", "mdr", "pc"],
          buses: ["mar-ram", "ram-mdr"],
          memRead: this.MAR
        };
      }

      this.IR = this.MDR;
      this.phase = "DECODE";
      this.microIndex = 0;

      return {
        phase: "FETCH",
        title: "IR ← MDR",
        detail: "Байт команды защёлкивается в регистре команд IR. Следующий такт — декодирование.",
        nodes: ["mdr", "ir"],
        buses: ["mdr-ir"]
      };
    }

    _decode() {
      const inst = ISA.BY_CODE[this.IR];

      if (!inst) {
        this.fault = {
          message: "Неизвестный код команды $" + ISA.hex8(this.IR) +
            " по адресу $" + ISA.hex8(this.instructionStart) + "."
        };
        this.phase = "FAULT";
        return {
          phase: "DECODE",
          title: "Неизвестная команда",
          detail: this.fault.message,
          nodes: ["ir", "cu"],
          buses: ["ir-cu"]
        };
      }

      const preview = ISA.disassemble(this.ram, this.instructionStart);

      this.current = {
        opcode: inst.code,
        mnemonic: inst.mnemonic,
        mode: inst.mode,
        syntax: inst.syntax,
        summary: inst.summary,
        startPC: this.instructionStart,
        text: preview.text
      };

      this.execProgram = this._buildExecution(inst);
      this.phase = "EXECUTE";
      this.microIndex = 0;

      return {
        phase: "DECODE",
        title: "Декодирование: " + inst.mnemonic,
        detail: "IR = $" + ISA.hex8(inst.code) + ". Управляющее устройство выбирает микропрограмму «" +
          inst.summary + "»",
        nodes: ["ir", "cu"],
        buses: ["ir-cu"]
      };
    }

    _execute() {
      if (this.microIndex >= this.execProgram.length) {
        this._finishInstruction();
        return {
          phase: "EXECUTE",
          title: "Команда завершена",
          detail: "Переходим к выборке следующей команды.",
          nodes: [],
          buses: []
        };
      }

      const micro = this.execProgram[this.microIndex];
      const result = micro.apply(this) || {};
      this.microIndex++;

      const finished = this.microIndex >= this.execProgram.length;

      const info = {
        phase: "EXECUTE",
        title: result.title || micro.title,
        detail: result.detail || micro.detail,
        nodes: result.nodes || micro.nodes || [],
        buses: result.buses || micro.buses || [],
        memRead: result.memRead != null ? result.memRead : micro.memRead,
        memWrite: result.memWrite != null ? result.memWrite : micro.memWrite
      };

      if (finished) this._finishInstruction();
      return info;
    }

    _finishInstruction() {
      if (this.current) {
        this.instructionCount++;
        this.lastInstruction = {
          mnemonic: this.current.mnemonic,
          text: this.current.text,
          startPC: this.instructionStart,
          cycles: Math.max(1, this.cycles - this.instructionStartCycle + 1),
          halted: this.halted,
          fault: !!this.fault
        };
      }

      this.phase = "FETCH";
      this.microIndex = 0;
      this.execProgram = [];
      this.current = null;
      this.tState = 0;
    }

    _operandImmediateSteps() {
      const steps = [];

      steps.push({
        title: "MAR ← PC",
        detail: "PC указывает на байт операнда сразу после кода команды.",
        nodes: ["pc", "mar"],
        buses: ["pc-mar"],
        apply: (cpu) => {
          cpu.MAR = cpu.PC;
        }
      });

      steps.push({
        title: "MDR ← RAM[MAR]; PC ← PC + 1",
        detail: "Операнд читается из памяти, а PC переходит к следующей команде.",
        nodes: ["mar", "ram", "mdr", "pc"],
        buses: ["mar-ram", "ram-mdr"],
        memRead: true,
        apply: (cpu) => {
          cpu.MDR = cpu.ram[cpu.MAR];
          cpu.lastRead = { addr: cpu.MAR, value: cpu.MDR, cycle: cpu.cycles + 1 };
          cpu.PC = (cpu.PC + 1) & 0xff;
        }
      });

      return steps;
    }

    _operandAddressSteps() {
      const steps = this._operandImmediateSteps();

      steps.push({
        title: "MAR ← MDR",
        detail: "Прочитанное число — это адрес. Передаём его из MDR в MAR.",
        nodes: ["mdr", "mar"],
        buses: ["mdr-mar"],
        apply: (cpu) => {
          cpu.MAR = cpu.MDR;
        }
      });

      return steps;
    }

    _readOperandSteps() {
      const steps = this._operandAddressSteps();

      steps.push({
        title: "MDR ← RAM[MAR]",
        detail: "По исполнительному адресу читается сам операнд.",
        nodes: ["mar", "ram", "mdr"],
        buses: ["mar-ram", "ram-mdr"],
        memRead: true,
        apply: (cpu) => {
          cpu.MDR = cpu.ram[cpu.MAR];
          cpu.lastRead = { addr: cpu.MAR, value: cpu.MDR, cycle: cpu.cycles + 1 };
        }
      });

      return steps;
    }

    _buildExecution(inst) {
      const steps = [];
      const mnemonic = inst.mnemonic;
      const mode = inst.mode;

      if (mode === "imm") {
        steps.push(...this._operandImmediateSteps());
      } else if (mode === "abs") {
        steps.push(...this._operandAddressSteps());
      }

      const needsMemoryRead =
        mode === "abs" &&
        ["LDA", "ADD", "SUB", "AND", "OR", "XOR", "CMP"].includes(mnemonic);

      if (needsMemoryRead) {
        steps.push({
          title: "MDR ← RAM[MAR]",
          detail: "По адресу из MAR читается значение операнда.",
          nodes: ["mar", "ram", "mdr"],
          buses: ["mar-ram", "ram-mdr"],
          memRead: true,
          apply: (cpu) => {
            cpu.MDR = cpu.ram[cpu.MAR];
            cpu.lastRead = { addr: cpu.MAR, value: cpu.MDR, cycle: cpu.cycles + 1 };
          }
        });
      }

      if (mnemonic === "NOP") {
        steps.push({
          title: "Пауза",
          detail: "NOP не меняет регистры — процессор просто переходит к следующей команде.",
          nodes: ["cu"],
          buses: [],
          apply: () => ({})
        });
        return steps;
      }

      if (mnemonic === "LDA") {
        steps.push({
          title: "A ← MDR",
          detail: "Операнд записывается в аккумулятор. Флаги Z и N обновляются.",
          nodes: ["mdr", "a", "flags"],
          buses: ["mdr-a", "alu-flags"],
          apply: (cpu) => {
            cpu.A = cpu.MDR;
            cpu.setZN(cpu.A);
            return {
              title: "A ← MDR = $" + ISA.hex8(cpu.A),
              detail: "Аккумулятор загружен. Z=" + cpu.flags.Z + ", N=" + cpu.flags.N + "."
            };
          }
        });
        return steps;
      }

      if (mnemonic === "STA") {
        steps.push({
          title: "MDR ← A",
          detail: "Значение аккумулятора выставляется на шину данных.",
          nodes: ["a", "mdr"],
          buses: ["a-mdr"],
          apply: (cpu) => {
            cpu.MDR = cpu.A;
          }
        });

        steps.push({
          title: "RAM[MAR] ← MDR",
          detail: "Байт записывается в память по адресу из MAR. Аккумулятор не меняется.",
          nodes: ["mar", "ram", "mdr"],
          buses: ["mar-ram", "ram-write"],
          memWrite: true,
          apply: (cpu) => {
            const event = cpu.writeMemory(cpu.MAR, cpu.MDR);
            const registerName = cpu.displayRegisterName(cpu.MAR);
            let detail = "Запись в память завершена. Аккумулятор сохранил значение $" + ISA.hex8(cpu.A) + ".";

            if (registerName) {
              detail = "Обновлён регистр дисплейного контроллера " + registerName + ".";
            }

            if (event) {
              detail += " Дисплей: " + (
                event.action === "clear"
                  ? "экран очищен."
                  : event.action === "vline"
                    ? "столбик x=" + event.x + " от y=" + event.y + " до 31."
                    : "пиксель (" + event.x + ", " + event.y + ") " + (
                        event.action === "plot" ? "включён." :
                        event.action === "erase" ? "выключен." : "инвертирован."
                      )
              );
            }

            return {
              title: registerName
                ? registerName + " ← $" + ISA.hex8(cpu.MDR)
                : "RAM[$" + ISA.hex8(cpu.MAR) + "] ← $" + ISA.hex8(cpu.MDR),
              detail
            };
          }
        });
        return steps;
      }

      if (["ADD", "SUB", "AND", "OR", "XOR", "CMP"].includes(mnemonic)) {
        steps.push({
          title: mnemonic + ": A и MDR → АЛУ",
          detail: "Арифметико-логическое устройство вычисляет результат и обновляет флаги.",
          nodes: ["a", "mdr", "alu", "flags"],
          buses: ["mdr-alu", "alu-a", "alu-flags"],
          apply: (cpu) => {
            const a = cpu.A;
            const b = cpu.MDR;
            let value = 0;
            let carry = cpu.flags.C;

            if (mnemonic === "ADD") {
              const sum = a + b;
              value = sum & 0xff;
              carry = sum > 0xff ? 1 : 0;
            } else if (mnemonic === "SUB" || mnemonic === "CMP") {
              value = (a - b) & 0xff;
              carry = a >= b ? 1 : 0;
            } else if (mnemonic === "AND") {
              value = a & b;
            } else if (mnemonic === "OR") {
              value = a | b;
            } else if (mnemonic === "XOR") {
              value = a ^ b;
            }

            if (mnemonic !== "CMP") cpu.A = value;
            if (mnemonic === "ADD" || mnemonic === "SUB" || mnemonic === "CMP") {
              cpu.flags.C = carry;
            }
            cpu.setZN(value);

            const symbol = {
              ADD: "+", SUB: "−", CMP: "−", AND: "&", OR: "|", XOR: "^"
            }[mnemonic];

            return {
              title: (mnemonic === "CMP" ? "Сравнение" : "A") + ": $" + ISA.hex8(a) +
                " " + symbol + " $" + ISA.hex8(b) + " = $" + ISA.hex8(value),
              detail: mnemonic === "CMP"
                ? "CMP не записывает результат в A, но обновляет Z, C и N."
                : "Результат записан в A. Z=" + cpu.flags.Z + ", C=" + cpu.flags.C + ", N=" + cpu.flags.N + ".",
              nodes: mnemonic === "CMP" ? ["a", "mdr", "alu", "flags"] : ["a", "mdr", "alu", "flags"],
              buses: mnemonic === "CMP" ? ["mdr-alu", "alu-flags"] : ["mdr-alu", "alu-a", "alu-flags"]
            };
          }
        });
        return steps;
      }

      if (mnemonic === "JMP" || mnemonic === "JZ" || mnemonic === "JNZ" ||
          mnemonic === "JC" || mnemonic === "JNC" || mnemonic === "JN") {
        const condition = {
          JMP: null, JZ: "Z", JNZ: "!Z", JC: "C", JNC: "!C", JN: "N"
        }[mnemonic];

        steps.push({
          title: condition ? "PC ← MAR, если " + condition : "PC ← MAR",
          detail: condition
            ? "Проверяется флаг " + condition.replace("!", "") + ". Если условие истинно, PC получает адрес из MAR."
            : "Безусловный переход: адрес из MAR записывается в PC.",
          nodes: condition ? ["mar", "pc", "flags"] : ["mar", "pc"],
          buses: ["mar-pc", "alu-flags"],
          apply: (cpu) => {
            let taken = true;
            if (mnemonic === "JZ") taken = cpu.flags.Z === 1;
            else if (mnemonic === "JNZ") taken = cpu.flags.Z === 0;
            else if (mnemonic === "JC") taken = cpu.flags.C === 1;
            else if (mnemonic === "JNC") taken = cpu.flags.C === 0;
            else if (mnemonic === "JN") taken = cpu.flags.N === 1;

            if (taken) cpu.PC = cpu.MAR;

            return {
              title: taken ? "Переход выполнен" : "Переход не выполнен",
              detail: taken
                ? "PC ← $" + ISA.hex8(cpu.PC) + "."
                : "Условие ложно — PC остался на следующей команде ($" + ISA.hex8(cpu.PC) + ").",
              buses: taken ? (condition ? ["mar-pc", "alu-flags"] : ["mar-pc"]) : [],
              nodes: taken ? (condition ? ["mar", "pc", "flags"] : ["mar", "pc"]) : (condition ? ["flags"] : [])
            };
          }
        });
        return steps;
      }

      if (mnemonic === "INC" || mnemonic === "DEC") {
        steps.push({
          title: mnemonic === "INC" ? "A ← A + 1" : "A ← A − 1",
          detail: "АЛУ прибавляет или вычитает единицу. Флаг переноса C не меняется.",
          nodes: ["a", "alu", "flags"],
          buses: ["alu-a", "alu-flags"],
          apply: (cpu) => {
            const before = cpu.A;
            cpu.A = mnemonic === "INC" ? (cpu.A + 1) & 0xff : (cpu.A - 1) & 0xff;
            cpu.setZN(cpu.A);
            return {
              title: "A: $" + ISA.hex8(before) + " → $" + ISA.hex8(cpu.A),
              detail: "Z=" + cpu.flags.Z + ", N=" + cpu.flags.N + ". Флаг C не изменён."
            };
          }
        });
        return steps;
      }

      if (mnemonic === "SHL" || mnemonic === "SHR") {
        steps.push({
          title: mnemonic === "SHL" ? "A ← A << 1" : "A ← A >> 1",
          detail: mnemonic === "SHL"
            ? "Все биты сдвигаются влево, старший бит уходит в флаг C."
            : "Все биты сдвигаются вправо, младший бит уходит в флаг C.",
          nodes: ["a", "alu", "flags"],
          buses: ["alu-a", "alu-flags"],
          apply: (cpu) => {
            const before = cpu.A;
            let carry;
            if (mnemonic === "SHL") {
              carry = (before >> 7) & 1;
              cpu.A = (before << 1) & 0xff;
            } else {
              carry = before & 1;
              cpu.A = before >> 1;
            }
            cpu.flags.C = carry;
            cpu.setZN(cpu.A);
            return {
              title: "A: $" + ISA.hex8(before) + " → $" + ISA.hex8(cpu.A),
              detail: "Выдвинутый бит попал в C=" + cpu.flags.C + ". Z=" + cpu.flags.Z + ", N=" + cpu.flags.N + "."
            };
          }
        });
        return steps;
      }

      if (mnemonic === "PUSH") {
        steps.push({
          title: "MAR ← SP",
          detail: "Адрес вершины стека берётся из указателя SP.",
          nodes: ["sp", "mar"],
          buses: ["sp-mar"],
          apply: (cpu) => {
            cpu.MAR = cpu.SP;
          }
        });
        steps.push({
          title: "MDR ← A",
          detail: "Значение аккумулятора выставляется на шину данных.",
          nodes: ["a", "mdr"],
          buses: ["a-mdr"],
          apply: (cpu) => {
            cpu.MDR = cpu.A;
          }
        });
        steps.push({
          title: "RAM[MAR] ← MDR",
          detail: "Значение записывается на стек.",
          nodes: ["mar", "ram", "mdr"],
          buses: ["mar-ram", "ram-write"],
          memWrite: true,
          apply: (cpu) => {
            cpu.writeMemory(cpu.MAR, cpu.MDR, { stack: true });
          }
        });
        steps.push({
          title: "SP ← SP − 1",
          detail: "Стек растёт вниз: указатель переходит к следующей свободной ячейке.",
          nodes: ["sp"],
          buses: [],
          apply: (cpu) => {
            cpu.SP = (cpu.SP - 1) & 0xff;
            return {
              title: "SP ← $" + ISA.hex8(cpu.SP),
              detail: "Вершина стека теперь $" + ISA.hex8(cpu.SP) + "."
            };
          }
        });
        return steps;
      }

      if (mnemonic === "POP") {
        steps.push({
          title: "SP ← SP + 1",
          detail: "Указатель стека поднимается к последнему сохранённому байту.",
          nodes: ["sp"],
          buses: [],
          apply: (cpu) => {
            cpu.SP = (cpu.SP + 1) & 0xff;
          }
        });
        steps.push({
          title: "MAR ← SP",
          detail: "Адрес вершины стека попадает в MAR.",
          nodes: ["sp", "mar"],
          buses: ["sp-mar"],
          apply: (cpu) => {
            cpu.MAR = cpu.SP;
          }
        });
        steps.push({
          title: "MDR ← RAM[MAR]",
          detail: "Байт читается из стека.",
          nodes: ["mar", "ram", "mdr"],
          buses: ["mar-ram", "ram-mdr"],
          memRead: true,
          apply: (cpu) => {
            cpu.MDR = cpu.ram[cpu.MAR];
            cpu.lastRead = { addr: cpu.MAR, value: cpu.MDR, cycle: cpu.cycles + 1, stack: true };
          }
        });
        steps.push({
          title: "A ← MDR",
          detail: "Снятое значение загружается в аккумулятор; флаги Z и N обновляются.",
          nodes: ["mdr", "a", "flags"],
          buses: ["mdr-a", "alu-flags"],
          apply: (cpu) => {
            cpu.A = cpu.MDR;
            cpu.setZN(cpu.A);
            return {
              title: "A ← $" + ISA.hex8(cpu.A) + " (POP)",
              detail: "Значение снято со стека. Z=" + cpu.flags.Z + ", N=" + cpu.flags.N + "."
            };
          }
        });
        return steps;
      }

      if (mnemonic === "OUT") {
        steps.push({
          title: "ПОРТ ← A",
          detail: "Байт из аккумулятора отправляется во внешний порт вывода.",
          nodes: ["a", "out"],
          buses: ["a-out"],
          apply: (cpu) => {
            const value = cpu.A;
            if (cpu.output.length < 512) {
              cpu.output.push({
                value,
                hex: ISA.hex8(value),
                char: value >= 32 && value <= 126 ? String.fromCharCode(value) : null,
                cycle: cpu.cycles + 1
              });
            }
            return {
              title: "OUT: $" + ISA.hex8(value) + " (" + value + ")",
              detail: "Байт отправлен в порт вывода." +
                (value >= 32 && value <= 126 ? " Как символ: «" + String.fromCharCode(value) + "»." : "")
            };
          }
        });
        return steps;
      }

      if (mnemonic === "HLT") {
        steps.push({
          title: "HLT — остановка",
          detail: "Процессор прекращает выборку команд. Регистры и память сохраняют значения.",
          nodes: ["cu"],
          buses: [],
          apply: (cpu) => {
            cpu.halted = true;
            return {
              title: "Программа завершена",
              detail: "HLT остановил процессор после " + (cpu.cycles + 1) + " тактов."
            };
          }
        });
        return steps;
      }

      // На случай, если в ISA появится новая команда без микропрограммы.
      steps.push({
        title: "Нет микропрограммы",
        detail: "Для команды " + mnemonic + " не описаны микрооперации.",
        nodes: ["cu"],
        buses: [],
        apply: (cpu) => {
          cpu.fault = { message: "Нет микропрограммы для команды " + mnemonic };
          cpu.phase = "FAULT";
        }
      });
      return steps;
    }
  }

  NanoCPU.DISPLAY = DISPLAY;

  return NanoCPU;
});
