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
