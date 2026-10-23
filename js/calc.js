/*
 * Калькулятор Nano-8.
 *
 * Каждая операция — отдельная программа для CPU. Пользователь вводит числа
 * в десятичном виде, числа раскладываются по байтам, подставляются в образ
 * памяти и процессор считает их по-настоящему: по шагам это видно в редакторе,
 * в регистрах и в сетке памяти.
 *
 * Разрядность разная, и это осознанно:
 *   + и − — 10 байт (80 бит), это дешёвая операция, код влезает с запасом;
 *   × и ÷ — 4 байта (32 бита), потому что 80-битные умножение и деление
 *           вместе со сдвигами 160-битных регистров в 256 байт не помещаются.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./assembler"));
  } else {
    root.NanoCalc = factory(root.NanoAssembler);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (assembler) {
  "use strict";

  /* ------------------------------------------------------------------ */
  /*  80-битное сложение                                                */
  /* ------------------------------------------------------------------ */

  const ADD10 = `
; Сложение двух 10-байтовых чисел (80 бит)
; little-endian: младший байт первым
;
; В ISA нет ADC, поэтому перенос живёт в байте CY и
; добавляется вручную с ветвлением по JC.
; Адреса операндов подставляются прямо в код (самомодификация).

LOOP:   LDA PA
        STA A_OP+1
        LDA PB
        STA B_OP+1
        LDA PS
        STA ST0+1
        LDA PS
        STA ST1+1

A_OP:   LDA $00
B_OP:   ADD $00          ; A = a[i] + b[i], C = перенос
        JC  OV
        ADD CY           ; + перенос из младшего байта
        JC  ST1
ST0:    STA $00          ; s[i], перенос = 0
        LDA #0
        STA CY
        JMP NEXT

OV:     ADD CY
        JMP ST1
ST1:    STA $00          ; s[i], перенос = 1
        LDA #1
        STA CY

NEXT:   LDA PA
        INC
        STA PA
        LDA PB
        INC
        STA PB
        LDA PS
        INC
        STA PS
        LDA CNT
        DEC
        STA CNT
        JNZ LOOP
        HLT

CY:     .byte 0
CNT:    .byte 10
PA:     .byte NUM_A
PB:     .byte NUM_B
PS:     .byte SUM
NUM_A:  .byte 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
NUM_B:  .byte 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
SUM:    .byte 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
`;

  /* ------------------------------------------------------------------ */
  /*  80-битное вычитание                                               */
  /* ------------------------------------------------------------------ */

  const SUB10 = `
; Вычитание двух 10-байтовых чисел (80 бит)
; a - b, little-endian
;
; Заём хранится в байте BR. Флаг C после SUB означает
; "нет заёма" (a >= b), поэтому логика зеркальна сложению.

LOOP:   LDA PA
        STA A_OP+1
        LDA PB
        STA B_OP+1
        LDA PS
        STA ST0+1
        LDA PS
        STA ST1+1

A_OP:   LDA $00
B_OP:   SUB $00          ; a[i] - b[i], C = нет заёма
        JC  GE
        SUB BR           ; a < b: занимаем у старшего разряда
        JMP ST1
GE:     SUB BR           ; вычесть заём из младшего байта
        JC  ST0
        JMP ST1
ST0:    STA $00          ; s[i], заём = 0
        LDA #0
        STA BR
        JMP NEXT
ST1:    STA $00          ; s[i], заём = 1
        LDA #1
        STA BR

NEXT:   LDA PA
        INC
        STA PA
        LDA PB
        INC
        STA PB
        LDA PS
        INC
        STA PS
        LDA CNT
        DEC
        STA CNT
        JNZ LOOP
        HLT

BR:     .byte 0
CNT:    .byte 10
PA:     .byte NUM_A
PB:     .byte NUM_B
PS:     .byte SUM
NUM_A:  .byte 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
NUM_B:  .byte 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
SUM:    .byte 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
`;

  /* ------------------------------------------------------------------ */
  /*  32 x 32 -> 64 бита, умножение                                     */
  /* ------------------------------------------------------------------ */

  const MUL32 = `
; Умножение 4-байтовых чисел, результат 8 байт
;
; Классический сдвиг-сложение, старший бит множителя обрабатывается первым:
;   P = 2P + (бит множителя) * A
; Старший бит множителя бесплатно попадает в флаг N после LDA.
; NUM_A — 8 байт: четыре значащих и четыре нуля, чтобы складывать
; перенос сразу во всё произведение.

OUTER:  LDA #PROD          ; P <<= 1, 8 байт
        STA PP
        LDA #8
        STA CNT
        LDA #0
        STA CI
SP:     LDA PP
        STA R1+1
        LDA PP
        STA W1+1
R1:     LDA $00
        SHL
        OR CI
W1:     STA $00
        LDA #0
        JNC SPC
        LDA #1
SPC:    STA CI
        LDA PP
        INC
        STA PP
        LDA CNT
        DEC
        STA CNT
        JNZ SP

        LDA NUM_B+3        ; старший бит множителя в N
        JN  ADDIT
        JMP SB

ADDIT:  LDA #NUM_A         ; P += A, 8 байт с переносом
        STA PA
        LDA #PROD
        STA PP
        LDA #8
        STA CNT
        LDA #0
        STA CI
ADD_L:  LDA PA
        STA LA+1
        LDA PP
        STA AP+1
        LDA PP
        STA T0+1
        LDA PP
        STA T1+1
LA:     LDA $00
AP:     ADD $00
        JC  AOV
        ADD CI
        JC  T1
T0:     STA $00
        LDA #0
        STA CI
        JMP AN
AOV:    ADD CI
        JMP T1
T1:     STA $00
        LDA #1
        STA CI
AN:     LDA PA
        INC
        STA PA
        LDA PP
        INC
        STA PP
        LDA CNT
        DEC
        STA CNT
        JNZ ADD_L

SB:     LDA #NUM_B         ; NUM_B <<= 1, 4 байта
        STA PB
        LDA #4
        STA CNT
        LDA #0
        STA CI
SBL:    LDA PB
        STA R2+1
        LDA PB
        STA W2+1
R2:     LDA $00
        SHL
        OR CI
W2:     STA $00
        LDA #0
        JNC SBC
        LDA #1
SBC:    STA CI
        LDA PB
        INC
        STA PB
        LDA CNT
        DEC
        STA CNT
        JNZ SBL

        LDA CNT2
        DEC
        STA CNT2
        JNZ OUTER
        HLT

CI:     .byte 0
CNT:    .byte 0
CNT2:   .byte 32
PA:     .byte 0
PB:     .byte 0
PP:     .byte 0
NUM_A:  .byte 0, 0, 0, 0, 0, 0, 0, 0
NUM_B:  .byte 0, 0, 0, 0
PROD:   .byte 0, 0, 0, 0, 0, 0, 0, 0
`;

  /* ------------------------------------------------------------------ */
  /*  32 / 32 -> 32, остаток 32                                         */
  /* ------------------------------------------------------------------ */

  const DIV32 = `
; Деление 4-байтовых чисел: частное и остаток
;
; Деление в столбик: N и R лежат подряд и сдвигаются одним 9-байтным
; блоком. Старший бит N при сдвиге въезжает в младший бит R — это и есть
; очередная цифра делимого, отдельно её доставать не нужно.
; Если R >= D, вычитаем D и дописываем единицу в младший бит N.
; После 32 шагов N содержит частное, R — остаток.

OUTER:  LDA #N             ; общий сдвиг [N R] влево, 9 байт
        STA PR
        LDA #9
        STA CNT
        LDA #0
        STA CI
SRL:    LDA PR
        STA R1+1
        LDA PR
        STA W1+1
R1:     LDA $00
        SHL
        OR CI
W1:     STA $00
        LDA #0
        JNC SRC
        LDA #1
SRC:    STA CI
        LDA PR
        INC
        STA PR
        LDA CNT
        DEC
        STA CNT
        JNZ SRL

; R >= D ? Сравниваем со старшего байта. D сверху всегда нулевой,
; поэтому сначала достаточно проверить только пятый байт остатка.

        LDA R+4
        JNZ CGE
        LDA R+3
        CMP D+3
        JC  C3
        JMP CLT
C3:     JNZ CGE
        LDA R+2
        CMP D+2
        JC  C2
        JMP CLT
C2:     JNZ CGE
        LDA R+1
        CMP D+1
        JC  C1
        JMP CLT
C1:     JNZ CGE
        LDA R+0
        CMP D+0
        JC  CGE
        JMP CLT

CGE:    LDA #R             ; R -= D, 5 байт с заёмом
        STA PR
        LDA #D
        STA PD
        LDA #5
        STA CNT
        LDA #0
        STA BR
SUBL:   LDA PR
        STA R3+1
        LDA PD
        STA S3+1
        LDA PR
        STA T0+1
        LDA PR
        STA T1+1
R3:     LDA $00
S3:     SUB $00
        JC  SGE
        SUB BR
        JMP T1
SGE:    SUB BR
        JC  T0
        JMP T1
T0:     STA $00
        LDA #0
        STA BR
        JMP SN
T1:     STA $00
        LDA #1
        STA BR
SN:     LDA PR
        INC
        STA PR
        LDA PD
        INC
        STA PD
        LDA CNT
        DEC
        STA CNT
        JNZ SUBL

        LDA N+0            ; бит частного
        OR #1
        STA N+0

CLT:    LDA CNT2
        DEC
        STA CNT2
        JNZ OUTER
        HLT

BR:     .byte 0
CI:     .byte 0
CNT:    .byte 0
CNT2:   .byte 32
PR:     .byte 0
PD:     .byte 0
N:      .byte 0, 0, 0, 0
R:      .byte 0, 0, 0, 0, 0
D:      .byte 0, 0, 0, 0, 0
`;

  /* ------------------------------------------------------------------ */
  /*  Описание операций                                                 */
  /* ------------------------------------------------------------------ */

  const operations = [
    {
      id: "add",
      symbol: "+",
      title: "Сложение",
      width: 10,
      program: ADD10.trim(),
      operands: [
        { name: "NUM_A", size: 10 },
        { name: "NUM_B", size: 10 }
      ],
      results: [{ name: "SUM", size: 10, label: "Сумма" }],
      note: "80 бит: перенос идёт по байтам через переменную CY"
    },
    {
      id: "sub",
      symbol: "−",
      title: "Вычитание",
      width: 10,
      program: SUB10.trim(),
      operands: [
        { name: "NUM_A", size: 10 },
        { name: "NUM_B", size: 10 }
      ],
      results: [{ name: "SUM", size: 10, label: "Разность" }],
      note: "80 бит: заём хранится в байте BR"
    },
    {
      id: "mul",
      symbol: "×",
      title: "Умножение",
      width: 4,
      program: MUL32.trim(),
      operands: [
        { name: "NUM_A", size: 4 },
        { name: "NUM_B", size: 4 }
      ],
      results: [{ name: "PROD", size: 8, label: "Произведение" }],
      note: "32 бита: сдвиг-сложение, старший бит множителя в флаге N"
    },
    {
      id: "div",
      symbol: "÷",
      title: "Деление",
      width: 4,
      program: DIV32.trim(),
      operands: [
        { name: "N", size: 4 },
        { name: "D", size: 4 }
      ],
      results: [
        { name: "N", size: 4, label: "Частное" },
        { name: "R", size: 4, label: "Остаток" }
      ],
      note: "32 бита: деление в столбик, 9-байтный сдвиг [N R]"
    }
  ];

  function find(id) {
    return operations.find((operation) => operation.id === id) || null;
  }

  function maxFor(operation) {
    return (1n << BigInt(operation.width * 8)) - 1n;
  }

  function bytesOf(value, size) {
    const bytes = [];
    let rest = BigInt(value);
    for (let i = 0; i < size; i++) {
      bytes.push(Number(rest & 0xffn));
      rest >>= 8n;
    }
    return bytes;
  }

  function valueOf(bytes) {
    let value = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) {
      value = (value << 8n) | BigInt(bytes[i] & 0xff);
    }
    return value;
  }

  function groupDigits(text) {
    return text.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  }

  function formatDecimal(value) {
    return groupDigits(String(value));
  }

  function formatHex(value) {
    const text = value.toString(16).toUpperCase().replace(/^0+(?=.)/, "");
    return "0x" + text;
  }

  /*
   * Разбирает десятичную строку.
   * Возвращает { ok: true, value } или { ok: false, error }.
   */
  function parse(text, operation) {
    const cleaned = String(text == null ? "" : text).replace(/[\s_]/g, "");
    if (!cleaned) return { ok: false, error: "Пустое число" };
    if (!/^\d+$/.test(cleaned)) {
      return { ok: false, error: "Нужно целое неотрицательное число" };
    }
    const value = BigInt(cleaned);
    const max = maxFor(operation);
    if (value > max) {
      return {
        ok: false,
        error: "Слишком большое: для этой операции максимум " + formatDecimal(max)
      };
    }
    return { ok: true, value };
  }

  /*
   * Проверка пары чисел перед вычислением.
   * Возвращает текст ошибки или null.
   */
  function validate(operation, a, b) {
    if (operation.id === "div" && b === 0n) {
      return "Делить на ноль нельзя: процессор вычитал бы ноль 32 раза и выдал бы одни единицы.";
    }
    return null;
  }

  /*
   * Собирает программу операции и подставляет числа в образ памяти.
   * Возвращает результат ассемблера: new NanoCPU(result.ram, result.start).
   */
  function build(operation, a, b) {
    const result = assembler.assemble(operation.program);
    if (!result.ok) {
      return { ok: false, error: "Ошибка сборки: " + JSON.stringify(result.errors) };
    }

    const values = [a, b];
    operation.operands.forEach((operand, index) => {
      const address = result.symbols[operand.name];
      if (address == null) {
        throw new Error("В программе нет метки " + operand.name);
      }
      const bytes = bytesOf(values[index], operand.size);
      for (let i = 0; i < bytes.length; i++) {
        result.ram[address + i] = bytes[i];
      }
    });

    return { ok: true, result };
  }

  /*
   * Читает результат из памяти процессора.
   */
  function readResults(operation, ram, symbols) {
    return operation.results.map((item) => {
      const address = symbols[item.name];
      const bytes = Array.from(ram.slice(address, address + item.size));
      return {
        label: item.label,
        name: item.name,
        bytes,
        value: valueOf(bytes)
      };
    });
  }

  return {
    operations,
    find,
    maxFor,
    bytesOf,
    valueOf,
    parse,
    validate,
    build,
    readResults,
    formatDecimal,
    formatHex,
    ADD10,
    SUB10,
    MUL32,
    DIV32
  };
});
