/*
 * Período "Emissão de ... até" com OK (13/10, pedido da Taís pelo Mateus).
 *
 * Os dois campos de data continuam sendo o campo brasileiro de 01/10 (dd/mm/aaaa,
 * barras sozinhas, calendário em português - campoDataBr, no app.js). O que muda:
 *   - antes a lista filtrava sozinha assim que a data ficava completa (e o relatório
 *     recarregava), às vezes antes de ela chegar no "até". Agora nada filtra até o
 *     OK ou o Enter;
 *   - atalhos (Este mês, Mês passado, Últimos 7 / 30 dias) preenchem e já aplicam;
 *   - data pela metade, que não existe, ou "até" antes do "de": avisa e não filtra.
 *
 * Script comum (não módulo), carregado antes do app.js. As funções puras têm teste
 * em test/periodo.test.ts.
 */

/** "01/10/2026" -> { iso: "2026-10-01" }. Vazio -> { iso: "" }. Senão -> { erro }. */
function lerDataBr(texto) {
  const t = String(texto ?? '').trim();
  if (!t) return { iso: '' };
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (!m) return { erro: 'data incompleta (use dd/mm/aaaa)' };
  const [dia, mes, ano] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (ano < 2000 || ano > 2100 || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    return { erro: `${t} não existe` };
  }
  return { iso: `${m[3]}-${m[2]}-${m[1]}` };
}

const ATALHOS_PERIODO = [
  ['este-mes', 'Este mês'],
  ['mes-passado', 'Mês passado'],
  ['7-dias', 'Últimos 7 dias'],
  ['30-dias', 'Últimos 30 dias'],
];

/** O período de cada atalho, contado a partir de `hoje` (data local). */
function atalhoPeriodo(qual, hoje = new Date()) {
  const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const y = hoje.getFullYear();
  const m = hoje.getMonth();
  const menos = (dias) => new Date(y, m, hoje.getDate() - dias);
  switch (qual) {
    case 'este-mes': return { de: iso(new Date(y, m, 1)), ate: iso(hoje) };
    case 'mes-passado': return { de: iso(new Date(y, m - 1, 1)), ate: iso(new Date(y, m, 0)) };
    case '7-dias': return { de: iso(menos(6)), ate: iso(hoje) };
    case '30-dias': return { de: iso(menos(29)), ate: iso(hoje) };
    default: return { de: '', ate: '' };
  }
}

/**
 * Liga o período já desenhado no HTML: #<p>-de e #<p>-ate (input type=date, que o
 * campoDataBr troca pela caixa dd/mm/aaaa), #<p>-ok, #<p>-limpar, #<p>-erro e, com
 * `atalhos`, #<p>-atalhos. `aplicar(de, ate)` recebe AAAA-MM-DD ('' = sem limite).
 */
function ligarPeriodo(p, aplicar, { atalhos = false } = {}) {
  const el = (s) => document.getElementById(`${p}-${s}`);
  const [de, ate, ok, limpar, erro] = ['de', 'ate', 'ok', 'limpar', 'erro'].map(el);
  // O que ela vê é a caixa de texto ao lado do campo escondido (campoDataBr).
  const caixaDe = (campo) => campo.closest('.data-br');
  const texto = (campo) => caixaDe(campo)?.querySelector('input[type="text"]')?.value ?? campo.value;
  const ler = (campo) => {
    const visivel = texto(campo);
    return visivel === campo.value ? { iso: campo.value } : lerDataBr(visivel);
  };
  let aplicado = { de: '', ate: '' };

  const pendente = () => {
    const a = ler(de);
    const b = ler(ate);
    ok.classList.toggle('primary', !!(a.erro || b.erro || a.iso !== aplicado.de || b.iso !== aplicado.ate));
  };
  const avisar = (t) => {
    erro.textContent = t ? '⚠ ' + t : '';
    erro.classList.toggle('hidden', !t);
  };
  const confirmar = () => {
    const a = ler(de);
    const b = ler(ate);
    if (a.erro) return avisar(`"de": ${a.erro}`);
    if (b.erro) return avisar(`"até": ${b.erro}`);
    if (a.iso && b.iso && a.iso > b.iso) return avisar('a data "de" está depois da data "até"');
    avisar('');
    de.value = a.iso;
    ate.value = b.iso;
    aplicado = { de: a.iso, ate: b.iso };
    limpar.classList.toggle('hidden', !a.iso && !b.iso);
    pendente();
    aplicar(a.iso, b.iso);
  };

  // Mexer na data (digitar, calendário) só marca o OK; quem aplica é o OK ou o Enter.
  // A caixa dd/mm/aaaa nasce depois (campoDataBr roda no fim do app.js): por isso a
  // escuta é no documento, conferindo se o evento veio de uma das duas caixas.
  const daqui = (ev) => [de, ate].some((c) => caixaDe(c)?.contains(ev.target));
  for (const campo of [de, ate]) campo.addEventListener('change', () => { avisar(''); pendente(); });
  document.addEventListener('input', (ev) => { if (daqui(ev)) { avisar(''); pendente(); } });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && daqui(ev)) { ev.preventDefault(); confirmar(); }
  });
  ok.addEventListener('click', confirmar);
  limpar.addEventListener('click', () => { de.value = ''; ate.value = ''; confirmar(); });

  const caixaAtalhos = el('atalhos');
  if (atalhos && caixaAtalhos) {
    caixaAtalhos.innerHTML = ATALHOS_PERIODO
      .map(([k, rotulo]) => `<button type="button" class="atalho-data" data-atalho="${k}">${rotulo}</button>`).join('');
    caixaAtalhos.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-atalho]');
      if (!b) return;
      const r = atalhoPeriodo(b.dataset.atalho);
      de.value = r.de;
      ate.value = r.ate;
      confirmar();
    });
  }
  pendente();
}
