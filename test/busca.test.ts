import { describe, it, expect } from 'vitest';
import { comoValor } from '../src/db/repo';

describe('comoValor: o que ela digita como valor na busca', () => {
  it('entende os jeitos comuns de escrever dinheiro', () => {
    expect(comoValor('289')).toBe(289);
    expect(comoValor('289,00')).toBe(289);
    expect(comoValor('289.00')).toBe(289);
    expect(comoValor('38,4')).toBe(38.4);
    expect(comoValor('1.234,56')).toBe(1234.56);
    expect(comoValor('1234,56')).toBe(1234.56);
    expect(comoValor('1234.56')).toBe(1234.56);
    expect(comoValor('1.234')).toBe(1234);
    expect(comoValor('12.345.678,90')).toBe(12345678.9);
    expect(comoValor('R$289,00')).toBe(289);
  });
  it('palavra não é valor', () => {
    for (const p of ['energetico', 'R$', '', ',', '1a2', 'lata473']) expect(comoValor(p), p).toBeNull();
  });
});

import { code128c } from '../src/nfe/codigo-barras';

describe('código de barras da chave (Code 128 C)', () => {
  it('bate com a codificação de referência de uma chave de 44 dígitos', () => {
    // Gerado com python-barcode (Code128) para a mesma chave.
    expect(code128c('42260783646984003044550010005047671000722978')).toBe(
      '1101001110010110111000111001001101001100010010111100100101000011001011001000010011110100110110011001101101100010001101110111010001101101100110011001000100110110011001100010111010001110110100001011001100100010011011001100100110000101110011001011000010100100111001101100011101011',
    );
  });
  it('recusa quantidade ímpar de dígitos', () => {
    expect(() => code128c('123')).toThrow();
  });
});
