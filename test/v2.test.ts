import { describe, it, expect } from 'vitest';
// @ts-expect-error módulo JS da tela, sem tipos
import * as v2 from '../public/v2/util.js';

/* A v2 muda a tela, não as regras: o que "precisa de você", "veio pronta" e "veio
   certo" tem de ser igual ao da tela de sempre (public/app.js). */

const nota = (p: Record<string, unknown>) => ({ total_itens: 3, itens_revisados: 0, itens_prontos: 0, cancelada_em: null, estorno: 0, ...p });
const item = (p: Record<string, unknown>) => ({
  id: 'i', revisado: 0, cfop_novo: '1101', procedencia: { fonte: 'aprendida', usos: 2 }, alertas: [], estilo: { estado: 'conferir' }, ...p,
});

describe('v2: as mesmas regras de lista da tela de sempre', () => {
  it('tratada, veio pronta e precisa de você', () => {
    expect(v2.notaTratada(nota({ itens_revisados: 3 }))).toBe(true);
    expect(v2.notaTratada(nota({ cancelada_em: '2026-10-01' }))).toBe(true);
    expect(v2.notaTratada(nota({ estorno: 1 }))).toBe(true);
    expect(v2.notaVeioPronta(nota({ itens_revisados: 1, itens_prontos: 2 }))).toBe(true);
    expect(v2.notaVeioPronta(nota({ itens_revisados: 1, itens_prontos: 1 }))).toBe(false);
    expect(v2.notaPrecisaDeVoce(nota({ itens_prontos: 2 }))).toBe(true);
    expect(v2.valorQueConta({ valor_total: 10, cancelada_em: 'x' })).toBe(0);
  });

  it('veio certo: ensinado ou fixado, regra igual, sem aviso; nunca o de outro produto nem palpite', () => {
    const n = { itens: [
      item({ id: 'a' }),
      item({ id: 'b', procedencia: { fonte: 'parecido' } }),
      item({ id: 'c', procedencia: { fonte: 'perfil' } }),
      item({ id: 'd', procedencia: { fonte: 'aprendida', regraAgora: '1403' } }),
      item({ id: 'e', alertas: [{ severidade: 'atencao' }] }),
      item({ id: 'f', procedencia: { fonte: 'fixada' } }),
      item({ id: 'g', revisado: 1 }),
      item({ id: 'h', cfop_novo: '' }),
    ] };
    expect(v2.itensQueVieramCertos(n).map((i: any) => i.id)).toEqual(['a', 'f']);
    expect(v2.itensQueVieramCertos(n, new Set(['a'])).map((i: any) => i.id)).toEqual(['f']);
  });

  it('cor da linha: verde só conferido, amarelo o que pede olho, vermelho o que bloqueia', () => {
    expect(v2.estadoDaLinha(item({ revisado: 1, estilo: { estado: 'conferido' } })).cor).toBe('verde');
    expect(v2.estadoDaLinha(item({ estilo: { estado: 'bloqueado' } })).cor).toBe('vermelho');
    expect(v2.estadoDaLinha(item({})).texto).toBe('veio certo');
    expect(v2.estadoDaLinha(item({ procedencia: { fonte: 'perfil' } })).cor).toBe('amarelo');
    expect(v2.estadoDaLinha(item({ procedencia: { fonte: 'parecido' } })).cor).toBe('amarelo');
    expect(v2.estadoDaLinha(item({ procedencia: { fonte: 'perfil' }, estilo: { estado: 'novo' } })).texto).toBe('produto novo');
  });

  it('origem do CFOP: azul o que vocês ensinaram, amarelo o que pede olho, nunca verde', () => {
    const cores = ['fixada', 'aprendida', 'parecido', 'manual', 'perfil'].map((f) => v2.origemDoCfop({ fonte: f })?.cor);
    expect(cores).toEqual(['azul', 'azul', 'amarelo', 'cinza', 'amarelo']);
    expect(v2.origemDoCfop({ fonte: 'aprendida', regraAgora: '1403' }).texto).toBe('regra hoje: 1403');
    expect(v2.origemDoCfop({ fonte: 'nenhuma' })).toBeNull();
  });

  it('mesma lista de CFOPs e mesmo grupo de ICMS', () => {
    expect(v2.CFOPS).toHaveLength(30);
    expect(v2.descricaoCfop('1403')).toBe('Compra para revenda — ST');
    expect([v2.grupoIcms('simples_fora'), v2.grupoIcms('simples_integral'), v2.grupoIcms('presumido'), v2.grupoIcms(null)])
      .toEqual(['simples_fora', 'simples', 'presumido', 'presumido']);
    expect(v2.nomeCompetencia('2026-10')).toBe('outubro de 2026');
    expect(v2.nomeCompetencia('')).toBe('todos os meses');
  });
});
