/*
 * Примеры программ для Nano-8.
 */
(function (root) {
  "use strict";

  const examples = [
    {
      id: "sum",
      title: "Сумма 1…10",
      note: "Цикл, счётчик и условный переход. В порт выводится 55.",
      source: `; Сумма чисел 1..10
; Результат: 55 в порту вывода

        LDA #0
        STA SUM
        LDA #1
        STA I

LOOP:   LDA SUM
        ADD I
        STA SUM

        LDA I
        CMP #10
        JZ DONE
        INC
        STA I
        JMP LOOP

DONE:   LDA SUM
        OUT
        HLT

SUM:    .byte 0
I:      .byte 0
`
    },
    {
      id: "fib",
      title: "Фибоначчи",
      note: "10 чисел Фибоначчи. Показывает работу с несколькими переменными.",
      source: `; Первые 10 чисел Фибоначчи
; 1, 1, 2, 3, 5, 8, 13, 21, 34, 55

        LDA #1
        STA A
        STA B
        LDA #10
        STA N

LOOP:   LDA A
        OUT
        ADD B
        STA NEXT
        LDA B
        STA A
        LDA NEXT
        STA B

        LDA N
        DEC
        STA N
        JNZ LOOP
        HLT

A:      .byte 0
B:      .byte 0
NEXT:   .byte 0
N:      .byte 0
`
    },
    {
      id: "mul",
      title: "Умножение 7 × 6",
      note: "Умножение через многократное сложение. В порт выводится 42.",
      source: `; 7 * 6 через повторное сложение
; Результат: 42

        LDA #0
        STA RES
        LDA #6
        STA CNT

LOOP:   LDA RES
        ADD #7
        STA RES

        LDA CNT
        DEC
        STA CNT
        JNZ LOOP

        LDA RES
        OUT
        HLT

RES:    .byte 0
CNT:    .byte 0
`
    },
    {
      id: "hello",
      title: "Строка в порт",
      note: "Каждый байт — ASCII-код символа. OUT печатает «Hello, 8-bit!».",
      source: `; ASCII-строка в порт вывода

        LDA #'H'
        OUT
        LDA #'e'
        OUT
        LDA #'l'
        OUT
        LDA #'l'
        OUT
        LDA #'o'
        OUT
        LDA #','
        OUT
        LDA #' '
        OUT
        LDA #'8'
        OUT
        LDA #'-'
        OUT
        LDA #'b'
        OUT
        LDA #'i'
        OUT
        LDA #'t'
        OUT
        LDA #'!'
        OUT
        HLT
`
    },
    {
      id: "powers",
      title: "Степени двойки",
      note: "Сдвиг SHL удваивает число. В порт уходят 1, 2, 4 … 128.",
      source: `; Восемь степеней двойки
; 1, 2, 4, 8, 16, 32, 64, 128

        LDA #1
        STA X
        LDA #8
        STA N

LOOP:   LDA X
        OUT
        SHL
        STA X

        LDA N
        DEC
        STA N
        JNZ LOOP
        HLT

X:      .byte 0
N:      .byte 0
`
    },
    {
      id: "stack",
      title: "Стек PUSH / POP",
      note: "Сохраняем 42 на стеке, затем восстанавливаем. OUT печатает 7, потом 42.",
      source: `; Демонстрация стека
; Сначала выводится 7, затем 42

        LDA #42
        PUSH

        LDA #7
        OUT

        POP
        OUT
        HLT
`
    },
    {
      id: "bits",
      title: "Битовые операции",
      note: "AND, OR и XOR над одним байтом. Смотрите значения в порту вывода.",
      source: `; Битовые операции
; $B3 -> $03 -> $83 -> $7C

        LDA #%10110011
        OUT
        AND #%00001111
        OUT
        OR  #%10000000
        OUT
        XOR #%11111111
        OUT
        HLT
`
    },
    {
      id: "bars",
      title: "Гистограмма",
      note: "Рисует на дисплее 32×32 восемь столбиков высотой 4…32 пикселя.",
      source: `; Гистограмма на дисплее 32x32
; 8 столбиков: 4, 8, 12, ... 32
; CTRL=5 — столбик от Y до низа

        .equ DISP_X,    $F8
        .equ DISP_Y,    $F9
        .equ DISP_CTRL, $FA

        LDA #2
        STA DISP_CTRL    ; очистить

        LDA #0
        STA BX           ; x = 0
        LDA #4
        STA H            ; высота

BAR:    LDA #32
        SUB H
        STA DISP_Y       ; верх
        LDA BX
        STA DISP_X
        LDA #5
        STA DISP_CTRL    ; столбик

        LDA BX
        ADD #4
        STA BX
        CMP #32
        JZ DONE

        LDA H
        ADD #4
        STA H
        JMP BAR

DONE:   HLT

BX:     .byte 0
H:      .byte 0
`
    },
    {
      id: "cross",
      title: "Диагонали",
      note: "Рисует крест из двух диагоналей — 64 пикселя на дисплее.",
      source: `; Крест из двух диагоналей
; Дисплей 32x32, 64 пикселя

        .equ DISP_X,    $F8
        .equ DISP_Y,    $F9
        .equ DISP_CTRL, $FA

        LDA #2
        STA DISP_CTRL    ; очистить

        LDA #0
        STA P

LOOP:   LDA P
        STA DISP_X
        STA DISP_Y       ; (P, P)
        LDA #1
        STA DISP_CTRL

        LDA #31
        SUB P
        STA DISP_Y       ; (P, 31-P)
        LDA P
        STA DISP_X
        LDA #1
        STA DISP_CTRL

        LDA P
        INC
        STA P
        CMP #32
        JNZ LOOP
        HLT

P:      .byte 0
`
    }
  ];

  root.NanoExamples = examples;
  if (typeof module === "object" && module.exports) module.exports = examples;
})(typeof globalThis !== "undefined" ? globalThis : this);
