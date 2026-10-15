/* Alfa Fiscal v2 — utilidades sem estado (formatação, CFOPs, regras de lista).
 *
 * As regras que decidem o que "precisa de você", "veio pronta" e "veio certo" são
 * as MESMAS da tela de sempre (public/app.js): a v2 muda a tela, não o critério.
 */

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const moeda = (v) =>
  v == null ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const dataCurta = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');

export const cnpjFormatado = (d) =>
  String(d ?? '').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');

export const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** "2026-10" -> "outubro de 2026"; "2026" -> "2026"; "" -> "todos os meses". */
export function nomeCompetencia(c) {
  if (!c) return 'todos os meses';
  if (c.length === 4) return c;
  return `${MESES[Number(c.slice(5, 7)) - 1] ?? c.slice(5, 7)} de ${c.slice(0, 4)}`;
}

export const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

/* Lista e ordem da planilha da Taís (28/09) — a mesma da tela de sempre. */
export const CFOPS = [
  ['1102', 'Compra para revenda'],
  ['2102', 'Compra para revenda — outro estado'],
  ['1101', 'Compra para industrialização'],
  ['2101', 'Compra para industrialização — outro estado'],
  ['1556', 'Compra de material para uso e consumo'],
  ['2556', 'Compra de uso e consumo — outro estado'],
  ['1403', 'Compra para revenda — ST'],
  ['2403', 'Compra para revenda com ST — outro estado'],
  ['1407', 'Compra de material de uso e consumo — ST'],
  ['2407', 'Compra de material de uso e consumo — ST — outro estado'],
  ['1551', 'Compra de bem para o ativo imobilizado'],
  ['2551', 'Compra de bem para o ativo imobilizado — outro estado'],
  ['1202', 'Devolução de venda'],
  ['2202', 'Devolução de venda — outro estado'],
  ['1949', 'Outra entrada não especificada'],
  ['2949', 'Outra entrada não especificada — outro estado'],
  ['1411', 'Devolução de venda com ST'],
  ['2411', 'Devolução de venda com ST — outro estado'],
  ['1653', 'Compra de combustível ou lubrificante por consumidor final'],
  ['1652', 'Compra de combustível ou lubrificante para comercialização'],
  ['1910', 'Entrada de bonificação, doação ou brinde'],
  ['2910', 'Entrada de bonificação, doação ou brinde — outro estado'],
  ['1117', 'Compra para comercialização — entrega futura'],
  ['2117', 'Compra para comercialização — entrega futura — outro estado'],
  ['1922', 'Simples faturamento de compra para entrega futura'],
  ['2922', 'Simples faturamento de compra para entrega futura — outro estado'],
  ['1916', 'Retorno de conserto ou reparo'],
  ['2916', 'Retorno de conserto ou reparo — outro estado'],
  ['1912', 'Entrada para demonstração ou mostruário'],
  ['2912', 'Entrada para demonstração ou mostruário — outro estado'],
];
export const descricaoCfop = (c) => (CFOPS.find(([x]) => x === String(c ?? '').trim()) ?? [c, ''])[1];

/* ---- Notas: as mesmas regras da tela de sempre ---- */

/** Nota sem nada a fazer: cancelada, estorno, ou todos os itens conferidos. */
export function notaTratada(n) {
  return !!n.cancelada_em || Number(n.estorno) === 1
    || ((n.total_itens ?? 0) > 0 && (n.itens_revisados ?? 0) >= n.total_itens);
}

/** Todos os itens que faltam vieram do que ensinaram para o próprio produto (15/10). */
export function notaVeioPronta(n) {
  if (notaTratada(n)) return false;
  const faltam = (n.total_itens ?? 0) - (n.itens_revisados ?? 0);
  return faltam > 0 && Number(n.itens_prontos ?? 0) >= faltam;
}

export const notaPrecisaDeVoce = (n) => !notaTratada(n) && !notaVeioPronta(n);

/** O valor que a nota soma: zero se cancelada ou estorno. */
export const valorQueConta = (n) => (n?.cancelada_em || Number(n?.estorno) === 1 ? 0 : (n?.valor_total ?? 0));

/**
 * Itens que vieram certos (29/09): CFOP do que ensinaram para o próprio produto ou de
 * padrão fixado, regra ainda com o mesmo valor, e sem aviso de atenção ou crítico.
 */
export function itensQueVieramCertos(n, ocupados = new Set()) {
  return (n?.itens ?? []).filter((i) => !i.revisado && !ocupados.has(i.id)
    && String(i.cfop_novo ?? '').trim() !== ''
    && ['aprendida', 'fixada'].includes(i.procedencia?.fonte) && !i.procedencia?.regraAgora
    && !(i.alertas ?? []).some((a) => a.severidade === 'critico' || a.severidade === 'atencao'));
}

/** Grupo das Regras de ICMS (13/10) — o mesmo grupoIcms do servidor. */
export function grupoIcms(regime) {
  if (regime === 'simples_fora') return 'simples_fora';
  if (regime && regime.startsWith('simples')) return 'simples';
  return 'presumido';
}

/* ---- Origem do CFOP: um selo só, com cor de significado fixo ---- */

/**
 * Azul = informação (vocês ensinaram / fixado / digitado). Amarelo = precisa de olho
 * (veio de outro produto, palpite do perfil, regra mudou). Nada de verde aqui: verde é
 * só "conferido".
 */
export function origemDoCfop(p) {
  const fonte = p?.fonte ?? 'nenhuma';
  if (p?.regraAgora) return { cor: 'amarelo', texto: `regra hoje: ${p.regraAgora}`, dica: `Esta linha ficou com outro CFOP; depois vocês ensinaram ${p.regraAgora}.` };
  if (fonte === 'fixada') return { cor: 'azul', texto: 'padrão fixado', dica: 'Padrão que a contabilidade fixou para este produto ou fornecedor.' };
  if (fonte === 'aprendida') {
    const n = Number(p?.usos ?? 0);
    return { cor: 'azul', texto: n > 1 ? `ensinado · ${n}x` : 'ensinado', dica: 'Vocês ensinaram isto neste produto.' };
  }
  if (fonte === 'parecido') return { cor: 'amarelo', texto: 'de outro produto', dica: 'Ninguém tratou ESTE produto ainda: o CFOP veio de outro produto com o mesmo NCM.' };
  if (fonte === 'manual') return { cor: 'cinza', texto: 'digitado', dica: 'Alguém digitou este valor nesta nota.' };
  if (fonte === 'perfil') return { cor: 'amarelo', texto: 'palpite', dica: 'Ninguém ensinou este item ainda: palpite pelo perfil fiscal da empresa.' };
  return null;
}

/**
 * Estado da linha em quatro cores. A base é o estilo do servidor (estiloDaLinha); a
 * tela só separa, entre os "conferir", os que vieram certos (mesma regra do botão
 * "Conferir os que vieram certos") para não pintar de amarelo o que não pede olho.
 */
export function estadoDaLinha(i) {
  const e = i.estilo?.estado ?? 'conferir';
  if (e === 'conferido' || i.revisado) return { cor: 'verde', texto: 'conferido' };
  if (e === 'bloqueado') return { cor: 'vermelho', texto: 'resolver' };
  const certo = String(i.cfop_novo ?? '').trim() !== '' && ['aprendida', 'fixada'].includes(i.procedencia?.fonte)
    && !i.procedencia?.regraAgora && !(i.alertas ?? []).some((a) => a.severidade === 'critico' || a.severidade === 'atencao');
  if (certo) return { cor: 'neutro', texto: 'veio certo' };
  if (e === 'novo') return { cor: 'amarelo', texto: 'produto novo' };
  if (e === 'conferir') return { cor: 'amarelo', texto: 'olhar' };
  return { cor: 'neutro', texto: 'veio certo' };
}

/** "produto 174,96 + frete 15,60" — o que compõe o valor contábil do item. */
export function composicaoContabil(i) {
  const partes = [`produto ${moeda(i.valor_total)}`];
  const soma = (rot, v) => { if (Number(v) > 0) partes.push(`+ ${rot} ${moeda(v)}`); };
  soma('frete', i.v_frete); soma('seguro', i.v_seg); soma('outras despesas', i.v_outro);
  soma('ST', Number(i.v_st ?? 0) + Number(i.v_fcp_st ?? 0)); soma('IPI', i.v_ipi);
  if (Number(i.v_desc) > 0) partes.push(`− desconto ${moeda(i.v_desc)}`);
  return partes.join(' ');
}
