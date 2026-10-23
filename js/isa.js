/*
 * Nano-8 — система команд.
 * Один байт данных, один байт адреса, аккумуляторная архитектура.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.NanoISA = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const OPCODES = [
    {
      code: 0x00, mnemonic: "NOP", mode: "none",
      syntax: "NOP", effect: "Ничего не делать", flags: "—",
      summary: "Пустая операция. Процессор тратит такт и идёт дальше."
    },
    {
      code: 0x01, mnemonic: "LDA", mode: "imm",
      syntax: "LDA #n", effect: "A ← n", flags: "Z N",
      summary: "Загрузить непосредственное число в аккумулятор."
    },
    {
      code: 0x02, mnemonic: "LDA", mode: "abs",
      syntax: "LDA addr", effect: "A ← MEM[addr]", flags: "Z N",
      summary: "Загрузить байт из памяти в аккумулятор."
    },
    {
      code: 0x03, mnemonic: "STA", mode: "abs",
      syntax: "STA addr", effect: "MEM[addr] ← A", flags: "—",
      summary: "Записать аккумулятор в память."
    },
    {
      code: 0x04, mnemonic: "ADD", mode: "imm",
      syntax: "ADD #n", effect: "A ← A + n", flags: "Z C N",
      summary: "Сложить аккумулятор с непосредственным числом."
    },
    {
      code: 0x05, mnemonic: "ADD", mode: "abs",
      syntax: "ADD addr", effect: "A ← A + MEM[addr]", flags: "Z C N",
      summary: "Сложить аккумулятор с байтом из памяти."
    },
    {
      code: 0x06, mnemonic: "SUB", mode: "imm",
      syntax: "SUB #n", effect: "A ← A − n", flags: "Z C N",
      summary: "Вычесть непосредственное число из аккумулятора."
    },
    {
      code: 0x07, mnemonic: "SUB", mode: "abs",
      syntax: "SUB addr", effect: "A ← A − MEM[addr]", flags: "Z C N",
      summary: "Вычесть байт из памяти из аккумулятора."
    },
    {
      code: 0x08, mnemonic: "AND", mode: "imm",
      syntax: "AND #n", effect: "A ← A & n", flags: "Z N",
      summary: "Побитовое И с непосредственным числом."
    },
    {
      code: 0x09, mnemonic: "AND", mode: "abs",
      syntax: "AND addr", effect: "A ← A & MEM[addr]", flags: "Z N",
      summary: "Побитовое И с байтом из памяти."
    },
    {
      code: 0x0A, mnemonic: "OR", mode: "imm",
      syntax: "OR #n", effect: "A ← A | n", flags: "Z N",
      summary: "Побитовое ИЛИ с непосредственным числом."
    },
    {
      code: 0x0B, mnemonic: "OR", mode: "abs",
      syntax: "OR addr", effect: "A ← A | MEM[addr]", flags: "Z N",
      summary: "Побитовое ИЛИ с байтом из памяти."
    },
    {
      code: 0x0C, mnemonic: "XOR", mode: "imm",
      syntax: "XOR #n", effect: "A ← A ^ n", flags: "Z N",
      summary: "Побитовое исключающее ИЛИ с непосредственным числом."
    },
    {
      code: 0x0D, mnemonic: "XOR", mode: "abs",
      syntax: "XOR addr", effect: "A ← A ^ MEM[addr]", flags: "Z N",
      summary: "Побитовое исключающее ИЛИ с байтом из памяти."
    },
    {
      code: 0x0E, mnemonic: "CMP", mode: "imm",
      syntax: "CMP #n", effect: "A − n → флаги", flags: "Z C N",
      summary: "Сравнить A с числом: вычесть, но не менять аккумулятор."
    },
    {
      code: 0x0F, mnemonic: "CMP", mode: "abs",
      syntax: "CMP addr", effect: "A − MEM[addr] → флаги", flags: "Z C N",
      summary: "Сравнить A с байтом из памяти, не меняя A."
    },
    {
      code: 0x10, mnemonic: "JMP", mode: "abs",
      syntax: "JMP addr", effect: "PC ← addr", flags: "—",
      summary: "Безусловный переход по адресу."
    },
    {
      code: 0x11, mnemonic: "JZ", mode: "abs",
      syntax: "JZ addr", effect: "PC ← addr, если Z = 1", flags: "—",
      summary: "Перейти, если результат предыдущей операции был нулём."
    },
    {
      code: 0x12, mnemonic: "JNZ", mode: "abs",
      syntax: "JNZ addr", effect: "PC ← addr, если Z = 0", flags: "—",
      summary: "Перейти, если результат предыдущей операции не ноль."
    },
    {
      code: 0x13, mnemonic: "JC", mode: "abs",
      syntax: "JC addr", effect: "PC ← addr, если C = 1", flags: "—",
      summary: "Перейти при переносе (беззнаковом переполнении)."
    },
    {
      code: 0x14, mnemonic: "JNC", mode: "abs",
      syntax: "JNC addr", effect: "PC ← addr, если C = 0", flags: "—",
      summary: "Перейти, если переноса не было."
    },
    {
      code: 0x15, mnemonic: "JN", mode: "abs",
      syntax: "JN addr", effect: "PC ← addr, если N = 1", flags: "—",
      summary: "Перейти, если старший бит результата равен единице."
    },
    {
      code: 0x16, mnemonic: "INC", mode: "none",
      syntax: "INC", effect: "A ← A + 1", flags: "Z N",
      summary: "Увеличить аккумулятор на единицу."
    },
    {
      code: 0x17, mnemonic: "DEC", mode: "none",
      syntax: "DEC", effect: "A ← A − 1", flags: "Z N",
      summary: "Уменьшить аккумулятор на единицу."
    },
    {
      code: 0x18, mnemonic: "SHL", mode: "none",
      syntax: "SHL", effect: "A ← A << 1", flags: "Z C N",
      summary: "Сдвиг влево. Старший бит уходит в перенос C."
    },
    {
      code: 0x19, mnemonic: "SHR", mode: "none",
      syntax: "SHR", effect: "A ← A >> 1", flags: "Z C N",
      summary: "Логический сдвиг вправо. Младший бит уходит в C."
    },
    {
      code: 0x1A, mnemonic: "PUSH", mode: "none",
      syntax: "PUSH", effect: "MEM[SP] ← A; SP ← SP − 1", flags: "—",
      summary: "Положить A на стек. Стек растёт вниз от $F7."
    },
    {
      code: 0x1B, mnemonic: "POP", mode: "none",
      syntax: "POP", effect: "SP ← SP + 1; A ← MEM[SP]", flags: "Z N",
      summary: "Снять значение со стека в аккумулятор."
    },
    {
      code: 0x1C, mnemonic: "OUT", mode: "none",
      syntax: "OUT", effect: "ПОРТ ← A", flags: "—",
      summary: "Отправить аккумулятор в порт вывода."
    },
    {
      code: 0x1D, mnemonic: "HLT", mode: "none",
      syntax: "HLT", effect: "Остановить процессор", flags: "—",
      summary: "Остановить выполнение программы."
    }
  ];

  const BY_CODE = Object.create(null);
  const MNEMONICS = Object.create(null);

  for (const inst of OPCODES) {
    inst.bytes = inst.mode === "none" ? 1 : 2;
    BY_CODE[inst.code] = inst;
    if (!MNEMONICS[inst.mnemonic]) MNEMONICS[inst.mnemonic] = Object.create(null);
    MNEMONICS[inst.mnemonic][inst.mode] = inst.code;
  }

  const HELP = [
    { mnemonic: "LDA", operands: "#n  /  addr", effect: "A ← n / MEM[addr]", flags: "Z N" },
    { mnemonic: "STA", operands: "addr", effect: "MEM[addr] ← A", flags: "—" },
    { mnemonic: "ADD", operands: "#n  /  addr", effect: "A ← A + операнд", flags: "Z C N" },
    { mnemonic: "SUB", operands: "#n  /  addr", effect: "A ← A − операнд", flags: "Z C N" },
    { mnemonic: "AND", operands: "#n  /  addr", effect: "A ← A & операнд", flags: "Z N" },
    { mnemonic: "OR", operands: "#n  /  addr", effect: "A ← A | операнд", flags: "Z N" },
    { mnemonic: "XOR", operands: "#n  /  addr", effect: "A ← A ^ операнд", flags: "Z N" },
    { mnemonic: "CMP", operands: "#n  /  addr", effect: "A − операнд → флаги", flags: "Z C N" },
    { mnemonic: "JMP", operands: "addr", effect: "PC ← addr", flags: "—" },
    { mnemonic: "JZ / JNZ", operands: "addr", effect: "Переход по Z", flags: "—" },
    { mnemonic: "JC / JNC", operands: "addr", effect: "Переход по C", flags: "—" },
    { mnemonic: "JN", operands: "addr", effect: "Переход по N", flags: "—" },
    { mnemonic: "INC / DEC", operands: "—", effect: "A ← A ± 1", flags: "Z N" },
    { mnemonic: "SHL / SHR", operands: "—", effect: "Сдвиг A", flags: "Z C N" },
    { mnemonic: "PUSH / POP", operands: "—", effect: "Стек через SP", flags: "Z N*" },
    { mnemonic: "OUT", operands: "—", effect: "Порт ← A", flags: "—" },
    { mnemonic: "NOP", operands: "—", effect: "Нет операции", flags: "—" },
    { mnemonic: "HLT", operands: "—", effect: "Остановка", flags: "—" }
  ];

  function hex8(value) {
    return (value & 0xff).toString(16).toUpperCase().padStart(2, "0");
  }

  function bin8(value) {
    return (value & 0xff).toString(2).padStart(8, "0");
  }

  function formatAddr(value) {
    return "$" + hex8(value);
  }

  function findSymbol(symbols, value) {
    if (!symbols) return null;
    for (const name of Object.keys(symbols)) {
      const entry = symbols[name];
      const symbolValue = typeof entry === "number" ? entry : entry.value;
      if (symbolValue === value) return name;
    }
    return null;
  }

  function disassemble(memory, address, symbols) {
    const addr = address & 0xff;
    const opcode = memory[addr] & 0xff;
    const inst = BY_CODE[opcode];

    if (!inst) {
      return {
        address: addr,
        opcode,
        mnemonic: "???",
        mode: "none",
        operand: null,
        bytes: [opcode],
        size: 1,
        text: "??? $" + hex8(opcode)
      };
    }

    if (inst.mode === "none") {
      return {
        address: addr,
        opcode,
        mnemonic: inst.mnemonic,
        mode: "none",
        operand: null,
        bytes: [opcode],
        size: 1,
        text: inst.mnemonic
      };
    }

    const operand = memory[(addr + 1) & 0xff] & 0xff;
    let operandText;
    let label = null;

    if (inst.mode === "imm") {
      operandText = "#$" + hex8(operand);
    } else {
      label = findSymbol(symbols, operand);
      operandText = label || formatAddr(operand);
    }

    return {
      address: addr,
      opcode,
      mnemonic: inst.mnemonic,
      mode: inst.mode,
      operand,
      label,
      bytes: [opcode, operand],
      size: 2,
      text: inst.mnemonic + " " + operandText,
      inst
    };
  }

  return {
    OPCODES,
    BY_CODE,
    MNEMONICS,
    HELP,
    hex8,
    bin8,
    formatAddr,
    findSymbol,
    disassemble
  };
});
