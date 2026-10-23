/*
 * Двухпроходный ассемблер для Nano-8.
 *
 * Поддерживает:
 *   метки:      LOOP:
 *   числа:      10, 0x0A, $0A, 0b1010, %1010, 'A'
 *   выражения:  LABEL+1, (BASE*2)&$FE, ~MASK
 *   директивы:  .org, .byte, .string
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./isa"));
  } else {
    root.NanoAssembler = factory(root.NanoISA);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (ISA) {
  "use strict";

  class AsmError extends Error {
    constructor(message, line) {
      super(message);
      this.name = "AsmError";
      this.line = line;
    }
  }

  function stripComment(text) {
    let quote = null;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }

      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ";") {
        return text.slice(0, i);
      } else if (ch === "/" && text[i + 1] === "/") {
        return text.slice(0, i);
      }
    }

    return text;
  }

  function splitArgs(text) {
    const parts = [];
    let current = "";
    let quote = null;
    let escaped = false;
    let depth = 0;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (quote) {
        current += ch;
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }

      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === "(") {
        depth++;
        current += ch;
      } else if (ch === ")") {
        depth--;
        current += ch;
      } else if (ch === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }

    parts.push(current.trim());
    return parts.filter((part) => part.length > 0);
  }

  function parseLine(raw, line) {
    const code = stripComment(raw);
    let rest = code.trim();
    const labels = [];

    try {
      let match;
      while ((match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(rest))) {
        labels.push(match[1]);
        rest = rest.slice(match[0].length).trim();
      }

      if (!rest) {
        return { type: "empty", line, raw, labels };
      }

      if (rest[0] === ".") {
        match = /^(\.[A-Za-z]+)\b\s*(.*)$/.exec(rest);
        if (!match) throw new AsmError("Некорректная директива", line);
        return {
          type: "directive",
          line,
          raw,
          labels,
          name: match[1].toLowerCase(),
          args: match[2].trim()
        };
      }

      match = /^([A-Za-z_][A-Za-z0-9_]*)\b\s*(.*)$/.exec(rest);
      if (!match) throw new AsmError("Не удалось разобрать строку", line);

      return {
        type: "instruction",
        line,
        raw,
        labels,
        mnemonic: match[1].toUpperCase(),
        operand: match[2].trim()
      };
    } catch (error) {
      return {
        type: "error",
        line,
        raw,
        labels,
        message: error.message
      };
    }
  }

  function describeMode(mnemonic, operand, line) {
    const modes = ISA.MNEMONICS[mnemonic];
    if (!modes) {
      throw new AsmError("Неизвестная команда «" + mnemonic + "»", line);
    }

    if (!operand) {
      if (modes.none === undefined) {
        throw new AsmError("Команде " + mnemonic + " нужен операнд", line);
      }
      return { mode: "none", code: modes.none, expr: "", bytes: 1 };
    }

    if (operand[0] === "#") {
      if (modes.imm === undefined) {
        throw new AsmError("Команда " + mnemonic + " не принимает #число", line);
      }
      const expr = operand.slice(1).trim();
      if (!expr) throw new AsmError("После # нет выражения", line);
      return { mode: "imm", code: modes.imm, expr, bytes: 2 };
    }

    if (modes.abs === undefined) {
      throw new AsmError("Команда " + mnemonic + " не принимает адрес", line);
    }

    return { mode: "abs", code: modes.abs, expr: operand, bytes: 2 };
  }

  function readQuoted(text, line) {
    const source = text.trim();
    if (!source.startsWith('"') && !source.startsWith("'")) {
      throw new AsmError("Ожидалась строка в кавычках", line);
    }

    const quote = source[0];
    let value = "";

    for (let i = 1; i < source.length; i++) {
      const ch = source[i];

      if (ch === quote) {
        if (source.slice(i + 1).trim()) {
          throw new AsmError("Лишние символы после строки", line);
        }
        return value;
      }

      if (ch !== "\\") {
        const code = ch.charCodeAt(0);
        if (code > 0xff) {
          throw new AsmError("Символ «" + ch + "» не помещается в байт", line);
        }
        value += ch;
        continue;
      }

      i++;
      if (i >= source.length) throw new AsmError("Незавершённая escape-последовательность", line);
      const escaped = source[i];

      if (escaped === "n") value += "\n";
      else if (escaped === "r") value += "\r";
      else if (escaped === "t") value += "\t";
      else if (escaped === "0") value += "\0";
      else if (escaped === "\\") value += "\\";
      else if (escaped === '"') value += '"';
      else if (escaped === "'") value += "'";
      else if (escaped === "x") {
        const hex = source.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
          throw new AsmError("После \\x нужны две hex-цифры", line);
        }
        value += String.fromCharCode(parseInt(hex, 16));
        i += 2;
      } else {
        value += escaped;
      }
    }

    throw new AsmError("Незакрытая кавычка", line);
  }

  function tokenize(expr, line) {
    const tokens = [];
    let i = 0;
    let expectValue = true;

    function push(type, value) {
      tokens.push({ type, value });
      expectValue = false;
    }

    while (i < expr.length) {
      const ch = expr[i];

      if (/\s/.test(ch)) {
        i++;
        continue;
      }

      if (ch === "(" || ch === ")" || ch === "+" || ch === "-" ||
          ch === "*" || ch === "/" || ch === "&" || ch === "|" ||
          ch === "^" || ch === "~") {
        tokens.push({ type: "op", value: ch });
        expectValue = ch !== ")";
        i++;
        continue;
      }

      if (ch === "<" || ch === ">") {
        if (expr[i + 1] !== ch) throw new AsmError("Ожидался оператор " + ch + ch, line);
        tokens.push({ type: "op", value: ch + ch });
        expectValue = true;
        i += 2;
        continue;
      }

      if (ch === "%") {
        if (expectValue && /[01]/.test(expr[i + 1] || "")) {
          let j = i + 1;
          while (j < expr.length && /[01]/.test(expr[j])) j++;
          tokens.push({ type: "number", value: parseInt(expr.slice(i + 1, j), 2) });
          expectValue = false;
          i = j;
          continue;
        }
        tokens.push({ type: "op", value: "%" });
        expectValue = true;
        i++;
        continue;
      }

      if (ch === "$") {
        let j = i + 1;
        while (j < expr.length && /[0-9a-fA-F]/.test(expr[j])) j++;
        if (j === i + 1) throw new AsmError("После $ нет hex-цифр", line);
        tokens.push({ type: "number", value: parseInt(expr.slice(i + 1, j), 16) });
        expectValue = false;
        i = j;
        continue;
      }

      if (/[0-9]/.test(ch)) {
        let j = i;
        let radix = 10;
        if (ch === "0" && (expr[i + 1] === "x" || expr[i + 1] === "X")) {
          radix = 16;
          j += 2;
          const start = j;
          while (j < expr.length && /[0-9a-fA-F]/.test(expr[j])) j++;
          if (j === start) throw new AsmError("После 0x нет hex-цифр", line);
          tokens.push({ type: "number", value: parseInt(expr.slice(start, j), 16) });
        } else if (ch === "0" && (expr[i + 1] === "b" || expr[i + 1] === "B")) {
          radix = 2;
          j += 2;
          const start = j;
          while (j < expr.length && /[01]/.test(expr[j])) j++;
          if (j === start) throw new AsmError("После 0b нет двоичных цифр", line);
          tokens.push({ type: "number", value: parseInt(expr.slice(start, j), 2) });
        } else {
          while (j < expr.length && /[0-9]/.test(expr[j])) j++;
          tokens.push({ type: "number", value: parseInt(expr.slice(i, j), 10) });
        }
        expectValue = false;
        i = j;
        continue;
      }

      if (ch === "'") {
        let j = i + 1;
        let valueText = "";

        if (j >= expr.length) throw new AsmError("Незакрытый символьный литерал", line);

        if (expr[j] === "\\") {
          j++;
          const escaped = expr[j];
          if (escaped === "n") valueText = "\n";
          else if (escaped === "r") valueText = "\r";
          else if (escaped === "t") valueText = "\t";
          else if (escaped === "0") valueText = "\0";
          else if (escaped === "\\") valueText = "\\";
          else if (escaped === "'") valueText = "'";
          else if (escaped === '"') valueText = '"';
          else if (escaped === "x") {
            const hex = expr.slice(j + 1, j + 3);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new AsmError("После \\x нужны две hex-цифры", line);
            valueText = String.fromCharCode(parseInt(hex, 16));
            j += 2;
          } else {
            valueText = escaped;
          }
          j++;
        } else {
          valueText = expr[j];
          j++;
        }

        if (expr[j] !== "'") throw new AsmError("Символьный литерал должен содержать один символ", line);
        tokens.push({ type: "number", value: valueText.charCodeAt(0) });
        expectValue = false;
        i = j + 1;
        continue;
      }

      if (/[A-Za-z_]/.test(ch)) {
        let j = i + 1;
        while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j++;
        tokens.push({ type: "ident", value: expr.slice(i, j) });
        expectValue = false;
        i = j;
        continue;
      }

      throw new AsmError("Неожиданный символ «" + ch + "» в выражении", line);
    }

    tokens.push({ type: "eof", value: null });
    return tokens;
  }

  class ExpressionParser {
    constructor(tokens, symbols, strict, line) {
      this.tokens = tokens;
      this.symbols = symbols;
      this.strict = strict;
      this.line = line;
      this.index = 0;
    }

    peek() {
      return this.tokens[this.index];
    }

    take() {
      return this.tokens[this.index++];
    }

    expectOp(value) {
      const token = this.take();
      if (token.type !== "op" || token.value !== value) {
        throw new AsmError("Ожидался «" + value + "»", this.line);
      }
    }

    parse() {
      const value = this.parseOr();
      if (this.peek().type !== "eof") {
        throw new AsmError("Лишний текст в выражении", this.line);
      }
      return value;
    }

    parseOr() {
      let value = this.parseXor();
      while (this.peek().type === "op" && this.peek().value === "|") {
        this.take();
        value |= this.parseXor();
      }
      return value;
    }

    parseXor() {
      let value = this.parseAnd();
      while (this.peek().type === "op" && this.peek().value === "^") {
        this.take();
        value ^= this.parseAnd();
      }
      return value;
    }

    parseAnd() {
      let value = this.parseShift();
      while (this.peek().type === "op" && this.peek().value === "&") {
        this.take();
        value &= this.parseShift();
      }
      return value;
    }

    parseShift() {
      let value = this.parseAdd();
      while (this.peek().type === "op" &&
             (this.peek().value === "<<" || this.peek().value === ">>")) {
        const op = this.take().value;
        const right = this.parseAdd();
        value = op === "<<" ? value << right : value >> right;
      }
      return value;
    }

    parseAdd() {
      let value = this.parseMul();
      while (this.peek().type === "op" &&
             (this.peek().value === "+" || this.peek().value === "-")) {
        const op = this.take().value;
        const right = this.parseMul();
        value = op === "+" ? value + right : value - right;
      }
      return value;
    }

    parseMul() {
      let value = this.parseUnary();
      while (this.peek().type === "op" &&
             (this.peek().value === "*" || this.peek().value === "/" ||
              this.peek().value === "%")) {
        const op = this.take().value;
        const right = this.parseUnary();
        if ((op === "/" || op === "%") && right === 0) {
          throw new AsmError("Деление на ноль", this.line);
        }
        if (op === "*") value *= right;
        else if (op === "/") value = Math.trunc(value / right);
        else value %= right;
      }
      return value;
    }

    parseUnary() {
      const token = this.peek();
      if (token.type === "op" && (token.value === "+" || token.value === "-" || token.value === "~")) {
        this.take();
        const value = this.parseUnary();
        if (token.value === "-") return -value;
        if (token.value === "~") return ~value;
        return value;
      }
      return this.parsePrimary();
    }

    parsePrimary() {
      const token = this.take();

      if (token.type === "number") return token.value;

      if (token.type === "ident") {
        if (Object.prototype.hasOwnProperty.call(this.symbols, token.value)) {
          return this.symbols[token.value];
        }
        if (this.strict) {
          throw new AsmError("Неизвестная метка «" + token.value + "»", this.line);
        }
        return 0;
      }

      if (token.type === "op" && token.value === "(") {
        const value = this.parseOr();
        this.expectOp(")");
        return value;
      }

      throw new AsmError("Ожидалось число или метка", this.line);
    }
  }

  function evaluate(expr, symbols, strict, line) {
    const trimmed = String(expr || "").trim();
    if (!trimmed) throw new AsmError("Пустое выражение", line);
    const tokens = tokenize(trimmed, line);
    return new ExpressionParser(tokens, symbols, strict, line).parse();
  }

  function expressionSize(expr, line) {
    const trimmed = expr.trim();
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
      return readQuoted(trimmed, line).length;
    }
    return 1;
  }

  function byteValues(text, symbols, strict, line) {
    const items = splitArgs(text);
    if (items.length === 0) throw new AsmError("После .byte нет данных", line);
    const bytes = [];

    for (const item of items) {
      if (item.startsWith('"') || item.startsWith("'")) {
        const string = readQuoted(item, line);
        for (const ch of string) bytes.push(ch.charCodeAt(0));
      } else {
        const value = evaluate(item, symbols, strict, line);
        if (value < 0 || value > 255) {
          throw new AsmError("Значение " + value + " не помещается в байт (0..255)", line);
        }
        bytes.push(value);
      }
    }

    return bytes;
  }

  function assemble(source) {
    const text = String(source == null ? "" : source).replace(/\r\n?/g, "\n");
    const rawLines = text.split("\n");
    const parsed = rawLines.map((line, index) => parseLine(line, index + 1));
    const errors = [];
    const warnings = [];
    const symbols = Object.create(null);
    const symbolLines = Object.create(null);
    const equates = Object.create(null);
    const listing = [];
    const ram = new Uint8Array(256);

    let firstAddress = null;
    let pc = 0;

    // ---------- проход 1: адреса, метки, размеры ----------
    for (const item of parsed) {
      try {
        for (const label of item.labels) {
          if (Object.prototype.hasOwnProperty.call(symbols, label)) {
            throw new AsmError("Метка «" + label + "» уже определена", item.line);
          }
          symbols[label] = pc;
          symbolLines[label] = item.line;
        }

        if (item.type === "error") {
          throw new AsmError(item.message, item.line);
        }

        if (item.type === "empty") continue;

        if (item.type === "directive") {
          if (item.name === ".equ") {
            const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(.+)$/.exec(item.args);
            if (!match) {
              throw new AsmError("Синтаксис: .equ ИМЯ, значение", item.line);
            }
            const name = match[1];
            const expression = match[2].trim();
            if (Object.prototype.hasOwnProperty.call(symbols, name)) {
              throw new AsmError("Имя «" + name + "» уже определено", item.line);
            }
            const value = evaluate(expression, symbols, true, item.line);
            if (value < 0 || value > 255) {
              throw new AsmError("Константа " + name + " не помещается в байт (0..255)", item.line);
            }
            symbols[name] = value;
            symbolLines[name] = item.line;
            equates[name] = value;
            continue;
          }

          if (item.name === ".org") {
            let value;
            try {
              value = evaluate(item.args, symbols, true, item.line);
            } catch (error) {
              throw new AsmError("В .org нужен адрес: " + error.message, item.line);
            }
            if (value < 0 || value > 255) {
              throw new AsmError(".org: адрес " + value + " вне диапазона 0..255", item.line);
            }
            pc = value;
            continue;
          }

          if (item.name === ".byte") {
            const items = splitArgs(item.args);
            if (items.length === 0) throw new AsmError("После .byte нет данных", item.line);
            let size = 0;
            for (const part of items) size += expressionSize(part, item.line);
            if (firstAddress === null) firstAddress = pc;
            pc += size;
            if (pc > 256) throw new AsmError("Данные выходят за границу памяти (256 байт)", item.line);
            continue;
          }

          if (item.name === ".string") {
            const value = readQuoted(item.args, item.line);
            if (firstAddress === null) firstAddress = pc;
            pc += value.length;
            if (pc > 256) throw new AsmError("Строка выходит за границу памяти (256 байт)", item.line);
            continue;
          }

          throw new AsmError("Неизвестная директива " + item.name, item.line);
        }

        if (item.type === "instruction") {
          const mode = describeMode(item.mnemonic, item.operand, item.line);
          if (firstAddress === null) firstAddress = pc;
          pc += mode.bytes;
          if (pc > 256) throw new AsmError("Команда выходит за границу памяти (256 байт)", item.line);
        }
      } catch (error) {
        errors.push({ line: item.line, message: error.message });
      }
    }

    // ---------- проход 2: байты ----------
    pc = 0;
    const occupied = new Map();
    let emittedBytes = 0;
    let lastInstructionLine = 0;

    function emitByte(value, line) {
      if (pc < 0 || pc > 255) {
        throw new AsmError("Адрес $" + pc.toString(16).toUpperCase() + " вне памяти", line);
      }
      if (occupied.has(pc)) {
        warnings.push({
          line,
          message: "Адрес $" + ISA.hex8(pc) + " перезаписан (до этого — строка " + occupied.get(pc) + ")"
        });
      }
      ram[pc] = value & 0xff;
      occupied.set(pc, line);
      pc++;
      emittedBytes++;
    }

    for (const item of parsed) {
      try {
        if (item.type === "error" || item.type === "empty") continue;

        if (item.type === "directive") {
          if (item.name === ".equ") {
            continue;
          } else if (item.name === ".org") {
            const value = evaluate(item.args, symbols, true, item.line);
            if (value < 0 || value > 255) {
              throw new AsmError(".org: адрес вне диапазона 0..255", item.line);
            }
            pc = value;
          } else if (item.name === ".byte") {
            const values = byteValues(item.args, symbols, true, item.line);
            const address = pc;
            for (const value of values) emitByte(value, item.line);
            listing.push({
              line: item.line,
              address,
              bytes: values.slice(),
              kind: "data",
              text: rawLines[item.line - 1].trim(),
              source: rawLines[item.line - 1]
            });
          } else if (item.name === ".string") {
            const value = readQuoted(item.args, item.line);
            const address = pc;
            const values = [];
            for (const char of value) values.push(char.charCodeAt(0));
            for (const byte of values) emitByte(byte, item.line);
            listing.push({
              line: item.line,
              address,
              bytes: values,
              kind: "data",
              text: rawLines[item.line - 1].trim(),
              source: rawLines[item.line - 1]
            });
          }
          continue;
        }

        if (item.type === "instruction") {
          const mode = describeMode(item.mnemonic, item.operand, item.line);
          const address = pc;
          const bytes = [mode.code];

          if (mode.mode !== "none") {
            const value = evaluate(mode.expr, symbols, true, item.line);
            if (value < 0 || value > 255) {
              throw new AsmError("Операнд " + value + " не помещается в байт (0..255)", item.line);
            }
            bytes.push(value);
          }

          for (const byte of bytes) emitByte(byte, item.line);
          lastInstructionLine = item.line;
          listing.push({
            line: item.line,
            address,
            bytes,
            kind: "instruction",
            mnemonic: item.mnemonic,
            mode: mode.mode,
            text: rawLines[item.line - 1].trim(),
            source: rawLines[item.line - 1],
            disasm: ISA.disassemble(ram, address, symbols).text
          });
        }
      } catch (error) {
        if (!errors.some((entry) => entry.line === item.line && entry.message === error.message)) {
          errors.push({ line: item.line, message: error.message });
        }
      }
    }

    if (emittedBytes === 0 && errors.length === 0) {
      warnings.push({ line: 1, message: "Программа не содержит ни одного байта" });
    }

    if (!listing.some((entry) => entry.kind === "instruction" && entry.mnemonic === "HLT")) {
      warnings.push({
        line: lastInstructionLine || 1,
        message: "В программе нет HLT — выполнение может уйти в NOP-ы"
      });
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      ram,
      start: firstAddress === null ? 0 : firstAddress,
      symbols,
      symbolLines,
      equates,
      listing,
      size: emittedBytes,
      source: text
    };
  }

  return {
    assemble,
    evaluate,
    splitArgs,
    stripComment,
    AsmError
  };
});
