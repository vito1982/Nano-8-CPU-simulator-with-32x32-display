/*
 * Тесты ядра Nano-8 и ассемблера.
 * Запуск: node tests/test-core.js
 */
"use strict";

const assert = require("node:assert/strict");
const ISA = require("../js/isa");
const { assemble } = require("../js/assembler");
const NanoCPU = require("../js/cpu");
const examples = require("../js/examples");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (error) {
    failed++;
    console.log("  ✗ " + name);
    console.log("    " + (error && error.message ? error.message : error));
  }
}

function section(name) {
  console.log("\n" + name);
}

function run(source, maxSteps = 30000) {
  const result = assemble(source);
  assert.equal(result.ok, true, "Ошибки сборки: " + JSON.stringify(result.errors));
  const cpu = new NanoCPU(result.ram, result.start);
  let steps = 0;

  while (!cpu.halted && !cpu.fault && steps < maxSteps) {
    cpu.step();
    steps++;
  }

  assert.equal(cpu.fault, null, "FAULT: " + (cpu.fault && cpu.fault.message));
  return { cpu, result, steps };
}

function outputs(source) {
  return run(source).cpu.output.map((entry) => entry.value);
}

section("ISA");

test("все 30 кодов уникальны и описаны", () => {
  assert.equal(ISA.OPCODES.length, 30);
  const codes = new Set(ISA.OPCODES.map((instruction) => instruction.code));
  assert.equal(codes.size, 30);
  for (const instruction of ISA.OPCODES) {
    assert.ok(instruction.mnemonic);
    assert.ok(instruction.bytes === 1 || instruction.bytes === 2);
  }
});

test("дизассемблер понимает immediate и absolute", () => {
  const ram = new Uint8Array(256);
  ram[0] = 0x01;
  ram[1] = 42;
  ram[2] = 0x02;
  ram[3] = 7;
  assert.equal(ISA.disassemble(ram, 0).text, "LDA #$2A");
  assert.equal(ISA.disassemble(ram, 2).text, "LDA $07");
});

section("Ассемблер");

test("базовая программа и listing", () => {
  const result = assemble("LDA #5\nOUT\nHLT\n");
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.ram.slice(0, 4)), [0x01, 5, 0x1c, 0x1d]);
  assert.equal(result.start, 0);
  assert.equal(result.size, 4);
  assert.equal(result.listing.length, 3);
  assert.equal(result.listing[0].disasm, "LDA #$05");
});

test("метки, .org, .byte и .string", () => {
  const result = assemble(`
        .org $10
START:  LDA #MSG
        OUT
        HLT
MSG:    .string "Hi"
        .byte 1, 2, $FF
`);
  assert.equal(result.ok, true);
  assert.equal(result.start, 0x10);
  assert.equal(result.symbols.START, 0x10);
  assert.equal(result.symbols.MSG, 0x14);
  assert.deepEqual(Array.from(result.ram.slice(0x14, 0x19)), [72, 105, 1, 2, 255]);
});

test("выражения, char-литералы и комментарии", () => {
  const result = assemble(`
        LDA #(2 + 3) * 4      ; 20
        STA $20
        LDA #'A'              // 65
        ADD #(1 << 4)
        AND #%11110000
        HLT
`);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.ram[1], 20);
  assert.equal(result.ram[3], 0x20);
  assert.equal(result.ram[5], 65);
  assert.equal(result.ram[7], 16);
  assert.equal(result.ram[9], 0xf0);
});

test("неизвестная команда — ошибка с номером строки", () => {
  const result = assemble("NOP\nWAT #1\nHLT");
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].line, 2);
  assert.match(result.errors[0].message, /Неизвестная команда/);
});

test("повторная метка — ошибка", () => {
  const result = assemble("A: NOP\nA: HLT");
  assert.equal(result.ok, false);
  assert.match(result.errors.map((error) => error.message).join(" "), /уже определена/);
});

test("неизвестная метка — ошибка второго прохода", () => {
  const result = assemble("JMP NOWHERE\nHLT");
  assert.equal(result.ok, false);
  assert.match(result.errors.map((error) => error.message).join(" "), /Неизвестная метка/);
});

test("STA не принимает immediate", () => {
  const result = assemble("STA #5\nHLT");
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /не принимает/);
});

test("число вне байта — ошибка", () => {
  const result = assemble("LDA #300\nHLT");
  assert.equal(result.ok, false);
  assert.match(result.errors.map((error) => error.message).join(" "), /не помещается/);
});

test(".org вне памяти — ошибка", () => {
  const result = assemble(".org 300\nHLT");
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /вне диапазона/);
});

test("незакрытая строка — ошибка", () => {
  const result = assemble('.string "oops\nHLT');
  assert.equal(result.ok, false);
  assert.match(result.errors.map((error) => error.message).join(" "), /Незакрытая/);
});

test("без HLT появляется предупреждение", () => {
  const result = assemble("LDA #1\nOUT");
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => /HLT/.test(warning.message)));
});

section("Ядро");

test("цикл fetch → decode → execute", () => {
  const result = assemble("LDA #7\nHLT");
  const cpu = new NanoCPU(result.ram, result.start);
  assert.equal(cpu.phase, "FETCH");

  const phases = [];
  for (let i = 0; i < 30 && !cpu.halted; i++) {
    const step = cpu.step();
    phases.push(step.phase);
  }

  assert.deepEqual(phases.slice(0, 4), ["FETCH", "FETCH", "FETCH", "DECODE"]);
  assert.ok(phases.includes("EXECUTE"));
  assert.equal(cpu.A, 7);
  assert.equal(cpu.halted, true);
});

test("LDA immediate / direct и STA", () => {
  const { cpu } = run(`
        LDA #42
        STA $20
        LDA #0
        LDA $20
        OUT
        HLT
`);
  assert.equal(cpu.A, 42);
  assert.equal(cpu.ram[0x20], 42);
  assert.deepEqual(cpu.output.map((entry) => entry.value), [42]);
});

test("ADD переносит C и обнуляет A при переполнении", () => {
  const { cpu } = run(`
        LDA #255
        ADD #1
        HLT
`);
  assert.equal(cpu.A, 0);
  assert.equal(cpu.flags.Z, 1);
  assert.equal(cpu.flags.C, 1);
  assert.equal(cpu.flags.N, 0);
});

test("SUB выставляет заём C=0 и отрицательный N", () => {
  const { cpu } = run(`
        LDA #1
        SUB #2
        HLT
`);
  assert.equal(cpu.A, 255);
  assert.equal(cpu.flags.C, 0);
  assert.equal(cpu.flags.Z, 0);
  assert.equal(cpu.flags.N, 1);
});

test("CMP не меняет A, но обновляет флаги", () => {
  const { cpu } = run(`
        LDA #10
        CMP #10
        HLT
`);
  assert.equal(cpu.A, 10);
  assert.equal(cpu.flags.Z, 1);
  assert.equal(cpu.flags.C, 1);
  assert.equal(cpu.flags.N, 0);
});

test("логические операции и сдвиги", () => {
  const { cpu } = run(`
        LDA #%10110011
        AND #%00001111
        STA $30
        OR  #%10000000
        STA $31
        XOR #%11111111
        STA $32
        LDA #%10000001
        SHL
        STA $33
        LDA #%10000001
        SHR
        STA $34
        HLT
`);
  assert.equal(cpu.ram[0x30], 0x03);
  assert.equal(cpu.ram[0x31], 0x83);
  assert.equal(cpu.ram[0x32], 0x7c);
  assert.equal(cpu.ram[0x33], 0x02);
  assert.equal(cpu.ram[0x34], 0x40);
  assert.equal(cpu.flags.C, 1);
});

test("PUSH / POP сохраняют порядок", () => {
  const { cpu } = run(`
        LDA #42
        PUSH
        LDA #7
        OUT
        POP
        OUT
        HLT
`);
  assert.deepEqual(cpu.output.map((entry) => entry.value), [7, 42]);
  assert.equal(cpu.SP, 0xf7);
  assert.equal(cpu.ram[0xf7], 42);
});

test(".equ определяет константы без байтов в памяти", () => {
  const result = assemble(`
        .equ DISP_X, $F8
        .equ MASK, %00001111
        LDA #MASK
        STA DISP_X
        HLT
`);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.size, 5);
  assert.equal(result.symbols.DISP_X, 0xf8);
  assert.equal(result.equates.DISP_X, 0xf8);
  assert.equal(result.equates.MASK, 0x0f);
  assert.equal(result.ram[0], 0x01);
  assert.equal(result.ram[1], 0x0f);
});

test("дисплей: memory-mapped X, Y и CTRL", () => {
  const result = assemble(`
        LDA #5
        STA $F8
        LDA #7
        STA $F9
        LDA #1
        STA $FA
        HLT
`);
  const cpu = new NanoCPU(result.ram, result.start);
  for (let i = 0; i < 200 && !cpu.halted; i++) cpu.step();

  assert.equal(cpu.display.x, 5);
  assert.equal(cpu.display.y, 7);
  assert.equal(cpu.display.count, 1);
  assert.equal(cpu.getDisplayPixel(5, 7), 1);
  assert.equal(cpu.getDisplayPixel(4, 7), 0);
  assert.equal(cpu.ram[0xf8], 5);
  assert.equal(cpu.ram[0xf9], 7);
  assert.equal(cpu.ram[0xfa], 1);
  assert.equal(cpu.SP, 0xf7);
});

test("дисплей: команды очистки, стирания, инверсии и столбика", () => {
  const result = assemble(`
        LDA #10
        STA $F8
        LDA #20
        STA $F9
        LDA #1
        STA $FA
        LDA #4
        STA $FA
        HLT
`);
  const cpu = new NanoCPU(result.ram, result.start);
  for (let i = 0; i < 200 && !cpu.halted; i++) cpu.step();

  assert.equal(cpu.getDisplayPixel(10, 20), 0);
  assert.equal(cpu.display.count, 0);

  cpu.setDisplayPixel(1, 1, 1);
  cpu.setDisplayPixel(1, 1, 0);
  assert.equal(cpu.getDisplayPixel(1, 1), 0);

  cpu.display.x = 3;
  cpu.display.y = 29;
  cpu.applyDisplayCommand(5);
  assert.equal(cpu.display.count, 3);
  assert.equal(cpu.getDisplayPixel(3, 31), 1);
  assert.equal(cpu.getDisplayPixel(3, 28), 0);

  cpu.applyDisplayCommand(2);
  assert.equal(cpu.display.count, 0);
  assert.equal(cpu.getDisplayPixel(3, 31), 0);
});

test("условные переходы JZ/JNZ", () => {
  const { cpu } = run(`
        LDA #0
        STA X
        LDA #3
        STA N
LOOP:   LDA X
        ADD #2
        STA X
        LDA N
        DEC
        STA N
        JNZ LOOP
        LDA X
        OUT
        HLT
X:      .byte 0
N:      .byte 0
`);
  assert.equal(cpu.A, 6);
  assert.equal(cpu.flags.Z, 0);
  assert.deepEqual(cpu.output.map((entry) => entry.value), [6]);
});

test("пример суммы выдаёт 55", () => {
  const example = examples.find((item) => item.id === "sum");
  assert.deepEqual(outputs(example.source), [55]);
});

test("пример Фибоначчи выдаёт 10 чисел", () => {
  const example = examples.find((item) => item.id === "fib");
  assert.deepEqual(outputs(example.source), [1, 1, 2, 3, 5, 8, 13, 21, 34, 55]);
});

test("пример умножения выдаёт 42", () => {
  const example = examples.find((item) => item.id === "mul");
  assert.deepEqual(outputs(example.source), [42]);
});

test("пример строки выдаёт Hello, 8-bit!", () => {
  const example = examples.find((item) => item.id === "hello");
  const values = outputs(example.source);
  assert.equal(values.map((value) => String.fromCharCode(value)).join(""), "Hello, 8-bit!");
});

test("пример степеней двойки", () => {
  const example = examples.find((item) => item.id === "powers");
  assert.deepEqual(outputs(example.source), [1, 2, 4, 8, 16, 32, 64, 128]);
});

test("пример стека", () => {
  const example = examples.find((item) => item.id === "stack");
  assert.deepEqual(outputs(example.source), [7, 42]);
});

test("пример битовых операций", () => {
  const example = examples.find((item) => item.id === "bits");
  assert.deepEqual(outputs(example.source), [179, 3, 131, 124]);
});

test("пример гистограммы рисует 8 столбиков", () => {
  const example = examples.find((item) => item.id === "bars");
  const { cpu } = run(example.source);
  assert.equal(cpu.display.count, 144);
  assert.equal(cpu.getDisplayPixel(0, 31), 1);
  assert.equal(cpu.getDisplayPixel(0, 27), 0);
  assert.equal(cpu.getDisplayPixel(28, 0), 1);
  assert.equal(cpu.getDisplayPixel(28, 1), 1);
});

test("пример диагоналей рисует 64 пикселя", () => {
  const example = examples.find((item) => item.id === "cross");
  const { cpu } = run(example.source);
  assert.equal(cpu.display.count, 64);
  assert.equal(cpu.getDisplayPixel(0, 0), 1);
  assert.equal(cpu.getDisplayPixel(31, 0), 1);
  assert.equal(cpu.getDisplayPixel(0, 31), 1);
  assert.equal(cpu.getDisplayPixel(31, 31), 1);
  assert.equal(cpu.getDisplayPixel(15, 16), 1);
  assert.equal(cpu.getDisplayPixel(0, 1), 0);
});

test("пример 80-битного сложения", () => {
  const example = examples.find((item) => item.id === "add80");
  const { cpu, result } = run(example.source);
  const text = cpu.output.map((entry) => String.fromCharCode(entry.value)).join("");
  assert.equal(text, "01000000000000000000");

  const sum = result.symbols.SUM;
  assert.deepEqual(
    Array.from(cpu.ram.slice(sum, sum + 10)),
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]
  );
});

test("80-битное сложение: переполнение уходит в перенос", () => {
  const example = examples.find((item) => item.id === "add80");
  const result = assemble(example.source);
  assert.equal(result.ok, true, JSON.stringify(result.errors));

  const a = result.symbols.NUM_A;
  const b = result.symbols.NUM_B;
  for (let i = 0; i < 10; i++) {
    result.ram[a + i] = 0xff;
    result.ram[b + i] = i === 0 ? 0x01 : 0x00;
  }

  const cpu = new NanoCPU(result.ram, result.start);
  let steps = 0;
  while (!cpu.halted && !cpu.fault && steps < 30000) {
    cpu.step();
    steps++;
  }

  assert.equal(cpu.fault, null, "FAULT: " + (cpu.fault && cpu.fault.message));
  const text = cpu.output.map((entry) => String.fromCharCode(entry.value)).join("");
  assert.equal(text, "1" + "0".repeat(20));
});

test("неизвестный опкод даёт FAULT", () => {
  const ram = new Uint8Array(256);
  ram[0] = 0xfe;
  const cpu = new NanoCPU(ram, 0);
  for (let i = 0; i < 10 && !cpu.fault; i++) cpu.step();
  assert.ok(cpu.fault);
  assert.match(cpu.fault.message, /Неизвестный код/);
});

test("PC после HLT указывает за команду", () => {
  const result = assemble("NOP\nLDA #1\nHLT");
  const cpu = new NanoCPU(result.ram, result.start);
  for (let i = 0; i < 100 && !cpu.halted; i++) cpu.step();
  assert.equal(cpu.halted, true);
  assert.equal(cpu.PC, 4);
});

test("деление на ноль в выражении — ошибка", () => {
  const result = assemble("LDA #(1/0)\nHLT");
  assert.equal(result.ok, false);
  assert.match(result.errors.map((error) => error.message).join(" "), /Деление на ноль/);
});

test("программа с меткой впереди инструкции", () => {
  const result = assemble("START:\n  LDA #1\n  HLT");
  assert.equal(result.ok, true);
  assert.equal(result.symbols.START, 0);
});

console.log("\n" + "Итог: " + passed + " прошло, " + failed + " упало.");
if (failed) process.exitCode = 1;
