import { describe, it, expect } from 'vitest';
import {
  paraBase32, deBase32, gerarSegredo, gerarHotp, gerarTotp, conferirTotp,
  contadorDe, uriDeProvisionamento, segredoLegivel,
} from '../src/auth/totp';

/**
 * Os vetores oficiais. Se estes passarem, qualquer aplicativo autenticador do
 * mundo gera o mesmo código que este servidor espera — que é a única prova que
 * interessa aqui. Errar TOTP em silêncio significa trancar o usuário para fora
 * da própria conta.
 */

// RFC 4226, apêndice D: segredo ASCII "12345678901234567890"
const SEGREDO_RFC = paraBase32(new TextEncoder().encode('12345678901234567890'));

describe('vetores da RFC 4226 (HOTP)', () => {
  const esperados = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];
  esperados.forEach((codigo, contador) => {
    it(`contador ${contador} → ${codigo}`, async () => {
      expect(await gerarHotp(SEGREDO_RFC, contador)).toBe(codigo);
    });
  });
});

describe('vetores da RFC 6238 (TOTP, SHA-1, 8 dígitos)', () => {
  const casos: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [segundos, codigo] of casos) {
    it(`t=${segundos} → ${codigo}`, async () => {
      expect(await gerarHotp(SEGREDO_RFC, Math.floor(segundos / 30), 8)).toBe(codigo);
    });
  }
});

describe('base32 — o formato que o aplicativo lê', () => {
  it('ida e volta preserva os bytes', () => {
    for (const n of [1, 5, 10, 20, 32]) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      expect([...deBase32(paraBase32(bytes))]).toEqual([...bytes]);
    }
  });

  it('aceita o que a pessoa digita: minúscula, espaço e padding', () => {
    const s = paraBase32(new TextEncoder().encode('12345678901234567890'));
    const sujo = segredoLegivel(s).toLowerCase() + '==';
    expect([...deBase32(sujo)]).toEqual([...deBase32(s)]);
  });

  it('recusa caractere que não existe no alfabeto', () => {
    expect(() => deBase32('ABC1')).toThrow();  // 1 não está no alfabeto base32
  });

  it('o segredo gerado tem 20 bytes, como o RFC recomenda', () => {
    expect(deBase32(gerarSegredo()).length).toBe(20);
  });

  it('dois segredos nunca saem iguais', () => {
    const s = new Set(Array.from({ length: 50 }, () => gerarSegredo()));
    expect(s.size).toBe(50);
  });
});

describe('conferência do código', () => {
  const agora = 1_700_000_000_000;

  it('aceita o código do momento', async () => {
    const s = gerarSegredo();
    expect(await conferirTotp(s, await gerarTotp(s, agora), agora)).toBe(contadorDe(agora));
  });

  it('aceita o anterior e o seguinte — relógio de celular atrasa', async () => {
    const s = gerarSegredo();
    for (const desvio of [-30_000, 30_000]) {
      const codigo = await gerarTotp(s, agora + desvio);
      expect(await conferirTotp(s, codigo, agora)).not.toBeNull();
    }
  });

  it('recusa o de dois passos atrás — a tolerância tem limite', async () => {
    const s = gerarSegredo();
    expect(await conferirTotp(s, await gerarTotp(s, agora - 90_000), agora)).toBeNull();
  });

  it('devolve o contador que casou, para bloquear reuso do mesmo código', async () => {
    const s = gerarSegredo();
    const anterior = contadorDe(agora) - 1;
    expect(await conferirTotp(s, await gerarHotp(s, anterior), agora)).toBe(anterior);
  });

  it('recusa código de outro segredo', async () => {
    expect(await conferirTotp(gerarSegredo(), await gerarTotp(gerarSegredo(), agora), agora)).toBeNull();
  });

  it('recusa lixo sem estourar', async () => {
    const s = gerarSegredo();
    for (const ruim of ['', '12345', '1234567', 'abcdef', '  ', null as never, undefined as never]) {
      expect(await conferirTotp(s, ruim, agora)).toBeNull();
    }
  });

  it('ignora espaço e traço no código digitado', async () => {
    const s = gerarSegredo();
    const c = await gerarTotp(s, agora);
    expect(await conferirTotp(s, `${c.slice(0, 3)} ${c.slice(3)}`, agora)).not.toBeNull();
  });
});

describe('a URI que vai para o QR', () => {
  it('carrega tudo que o aplicativo precisa', () => {
    const u = uriDeProvisionamento('JBSWY3DPEHPK3PXP', 'contadora@alfacontabil.net');
    expect(u).toMatch(/^otpauth:\/\/totp\//);
    expect(u).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(u).toContain('issuer=Planee+Fiscal');
    expect(u).toContain('digits=6');
    expect(u).toContain('period=30');
  });

  it('escapa o rótulo — e-mail tem @ e o emissor tem espaço', () => {
    const u = uriDeProvisionamento('JBSWY3DPEHPK3PXP', 'a b@c.com');
    expect(u).not.toContain(' ');
    expect(u).toContain('%40');
  });
});
