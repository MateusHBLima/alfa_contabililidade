/* Alfa Fiscal v2 — tela da Nota.
 *
 * Uma linha por item, todas da mesma altura; o detalhe de cada item (de onde veio,
 * como estava, avisos, valores, nome no XML) fica no painel ao lado, que abre ao
 * clicar na linha. Um botão principal que muda com a nota; o resto em "Mais".
 * Teclado: setas mudam de item, digita o CFOP e Enter grava, Ctrl+Enter confere.
 */

import { api, enviar } from './api.js';
import { $, $$, esc, moeda, dataCurta, plural, CFOPS, descricaoCfop, itensQueVieramCertos, origemDoCfop,
  estadoDaLinha, composicaoContabil, notaPrecisaDeVoce, notaVeioPronta, cnpjFormatado } from './util.js';
import { estado, pode, endereco, linkTelaAntiga } from './estado.js';
import { abrirMenu, aviso, avisoErro, confirmar, comEspera } from './ui.js';
import { atualizarDepoisDeGravar } from './app.js';

const ROTULO_CAMPO = {
  cfop: 'CFOP de entrada', descricao: 'Nome no XML', conferido: 'Conferência',
  cst_entrada: 'CST de entrada', conta_contabil: 'Conta contábil',
  credito_icms: 'Crédito de ICMS', credito_pis: 'Crédito de PIS', credito_cofins: 'Crédito de COFINS',
};

const n = () => estado.nota;
const item = (id) => (n()?.itens ?? []).find((i) => i.id === id);
const fechada = () => !!n()?.nota?.cancelada_em || Number(n()?.nota?.estorno) === 1;
const podeEditar = () => pode('notas.editar_cfop') && !fechada();

/* ------------------------------------------------------------ abrir */

export async function telaNota(notaId, itemId = null) {
  const mesmaNota = estado.nota?.nota?.id === notaId;
  if (!mesmaNota) {
    estado.nota = await comEspera(api(`/api/notas/${notaId}`));
    estado.buscaItens = '';
    estado.painel = null;
    const faltam = estado.nota.itens.filter((i) => !i.revisado).length;
    estado.filtroItens = itemId || faltam === 0 ? 'todos' : 'faltam';
    estado.selecionado = itemId ?? itensVisiveis()[0]?.id ?? null;
  }
  if (itemId) { estado.filtroItens = 'todos'; estado.selecionado = itemId; estado.painel = itemId; }
  desenhar();
  if (itemId) $(`tr[data-item="${CSS.escape(itemId)}"]`)?.scrollIntoView({ block: 'center' });
}

async function recarregar() {
  const id = n()?.nota?.id;
  if (!id) return;
  estado.nota = await api(`/api/notas/${id}`);
  desenharTabela();
  desenharCabeca();
  desenharTotais();
  if (estado.painel) desenharPainel();
}

/* ------------------------------------------------------------ desenho */

function desenhar() {
  const nota = n().nota;
  document.title = `NF ${nota.numero} · Alfa Fiscal`;
  $('#tela').innerHTML = `
    <div class="cabeca-nota" id="cabeca-nota"></div>
    <div id="avisos-nota"></div>
    <div class="barra">
      <div class="abas" role="tablist" id="abas-itens"></div>
      <div class="barra-dir">
        <input type="search" id="filtro-itens" class="filtro-itens" placeholder="Filtrar itens desta nota" value="${esc(estado.buscaItens)}" autocomplete="off">
      </div>
    </div>
    <div class="tabela-caixa"><table class="tabela tabela-itens">
      <thead><tr>
        <th class="col-n">#</th><th>Produto</th><th class="col-cfop-o" title="CFOP de saída, como o fornecedor emitiu">Saída</th>
        <th class="col-cfop" title="CFOP de entrada">Entrada</th><th class="col-origem">Origem</th>
        <th class="col-valor num" title="Valor contábil: produto + frete, seguro, despesas, ST e IPI − desconto">Valor contábil</th>
        <th class="col-sit">Situação</th><th class="col-acao"></th>
      </tr></thead>
      <tbody id="itens"></tbody>
    </table></div>
    <details class="totais" id="totais"></details>
    <p class="dica-teclado">↑ ↓ muda de item · digite o CFOP e Enter grava · Ctrl+Enter confere o item · clique na linha para ver tudo do item · Esc fecha</p>
    <datalist id="lista-cfops">${CFOPS.map(([c, d]) => `<option value="${c}">${esc(d)}</option>`).join('')}</datalist>`;

  $('#filtro-itens').addEventListener('input', (ev) => { estado.buscaItens = ev.target.value.trim().toLowerCase(); desenharTabela(); });
  $('#itens').addEventListener('click', cliqueNaTabela);
  $('#itens').addEventListener('change', mudouCampo);
  $('#itens').addEventListener('keydown', teclaNaTabela);
  $('#itens').addEventListener('focusin', (ev) => {
    const tr = ev.target.closest('tr[data-item]');
    if (tr) marcarSelecionado(tr.dataset.item);
  });
  desenharCabeca();
  desenharAvisos();
  desenharTabela();
  desenharTotais();
  if (estado.painel) desenharPainel(); else fecharPainel();
}

function desenharCabeca() {
  const a = n();
  const nota = a.nota;
  const total = a.itens.length;
  const feitos = a.itens.filter((i) => i.revisado).length;
  const pct = total ? Math.round((feitos / total) * 100) : 0;
  const principal = botaoPrincipal();
  $('#cabeca-nota').innerHTML = `
    <a class="btn sutil voltar" href="${endereco({ t: 'notas' })}" title="Voltar para a lista">← Notas</a>
    <div class="nota-id">
      <h1>NF ${esc(nota.numero)} <span class="nota-forn">${esc(nota.emit_nome ?? nota.emit_cnpj)}</span></h1>
      <p>${dataCurta(nota.dh_emi)} · ${nota.cancelada_em ? `<s>R$ ${moeda(nota.valor_total)}</s> vale zero` : `R$ ${moeda(nota.valor_total)}`} · ${plural(total, 'item', 'itens')}
        <span class="suave">· ${esc(a.resumo?.aprendizado ?? '')}</span></p>
    </div>
    <div class="nota-progresso" title="${feitos} de ${total} itens conferidos">
      <div class="progresso progresso-grande"><span style="width:${pct}%"></span></div>
      <span><b>${feitos}</b> de ${total} conferidos</span>
    </div>
    ${principal ? `<button type="button" class="btn ${principal.classe}" id="btn-principal" title="${esc(principal.dica ?? '')}">${esc(principal.rotulo)}</button>` : ''}
    <button type="button" class="btn" id="btn-mais" aria-haspopup="true">Mais ▾</button>`;
  $('#btn-principal')?.addEventListener('click', principal?.acao);
  $('#btn-mais').addEventListener('click', menuMais);
}

/** O botão principal muda com a nota: conferir os certos, depois o resto, depois a próxima nota. */
function botaoPrincipal() {
  const a = n();
  if (fechada()) return null;
  const faltam = a.itens.filter((i) => !i.revisado && !estado.conferindo.has(i.id));
  const certos = itensQueVieramCertos(a, estado.conferindo);
  if (faltam.length && pode('notas.editar_cfop')) {
    if (certos.length) {
      return {
        rotulo: certos.length === faltam.length ? `✓ Conferir ${certos.length === 1 ? 'o item' : `os ${certos.length} itens`}` : `✓ Conferir os ${certos.length} que vieram certos`,
        classe: 'primario',
        dica: '“Vocês ensinaram” neste produto ou padrão fixado, sem nenhum aviso. O que veio de outro produto ou de palpite fica para você olhar.',
        acao: () => conferir(certos.map((i) => i.id)),
      };
    }
    return { rotulo: `✓ Conferir ${faltam.length === 1 ? 'o que falta' : `os ${faltam.length} que faltam`}…`, classe: 'primario', acao: () => conferirResto(faltam) };
  }
  const prox = proximaNota();
  if (prox) return { rotulo: 'Próxima nota →', classe: 'primario', dica: `NF ${prox.numero} · ${prox.emit_nome ?? ''}`, acao: () => { location.hash = endereco({ t: 'nota', n: prox.id, i: null }); } };
  return { rotulo: '← Voltar às notas', classe: '', acao: () => { location.hash = endereco({ t: 'notas' }); } };
}

function proximaNota() {
  const atual = n().nota.id;
  const lista = estado.notas.filter((x) => x.id !== atual && (notaPrecisaDeVoce(x) || notaVeioPronta(x)));
  const idx = estado.notas.findIndex((x) => x.id === atual);
  return lista.find((x) => estado.notas.indexOf(x) > idx) ?? lista[0] ?? null;
}

function desenharAvisos() {
  const nota = n().nota;
  const partes = [];
  if (nota.cancelada_em) {
    partes.push(`<div class="nota-aviso nota-aviso-forte"><b>Nota cancelada</b> — vale zero: fica fora das somas, dos relatórios e do XML corrigido.
      <span class="suave">${esc(nota.cancelada_motivo ?? '')} · ${dataCurta(nota.cancelada_em)}</span></div>`);
  } else if (Number(nota.estorno) === 1) {
    partes.push(`<div class="nota-aviso nota-aviso-forte"><b>↩ Nota de estorno</b> — veio como entrada emitida por ${esc(nota.emit_nome ?? nota.emit_cnpj)}.
      Para a empresa é uma saída: não soma nas entradas, nos relatórios nem no XML corrigido. <b>Lançar à mão nas saídas.</b></div>`);
  }
  if (n().resumo?.bloqueiaExportacao) partes.push('<div class="nota-aviso">Algum item está sem CFOP de entrada: o XML corrigido desta nota fica bloqueado até preencher.</div>');
  $('#avisos-nota').innerHTML = partes.join('');
}

function itensVisiveis() {
  const busca = estado.buscaItens;
  return (n()?.itens ?? []).filter((i) => {
    if (estado.filtroItens === 'faltam' && i.revisado) return false;
    if (estado.filtroItens === 'conferidos' && !i.revisado) return false;
    if (!busca) return true;
    return `${i.x_prod_original} ${i.x_prod_novo ?? ''} ${i.c_prod ?? ''} ${i.ncm ?? ''} ${i.cfop_novo ?? ''}`.toLowerCase().includes(busca);
  });
}

function desenharAbas() {
  const itens = n().itens;
  const faltam = itens.filter((i) => !i.revisado).length;
  const abas = [['faltam', 'Faltam', faltam], ['conferidos', 'Conferidos', itens.length - faltam], ['todos', 'Todos', itens.length]];
  $('#abas-itens').innerHTML = abas.map(([k, rot, q]) => `<button type="button" role="tab" class="aba${estado.filtroItens === k ? ' ativa' : ''}" data-filtro="${k}" aria-selected="${estado.filtroItens === k}">${rot} <span class="aba-num">${q}</span></button>`).join('');
  $$('#abas-itens [data-filtro]').forEach((b) => b.addEventListener('click', () => { estado.filtroItens = b.dataset.filtro; desenharTabela(); }));
}

function linhaItem(i) {
  const st = estadoDaLinha(i);
  const o = origemDoCfop(i.procedencia);
  const nome = i.x_prod_novo || i.x_prod_original || '';
  const avisos = (i.alertas ?? []).filter((a) => a.severidade === 'critico' || a.severidade === 'atencao');
  const conferindo = estado.conferindo.has(i.id);
  const cfopForaDoNormal = i.marcas?.cfopForaDoNormal;
  return `<tr data-item="${esc(i.id)}" class="item item-${st.cor}${i.id === estado.selecionado ? ' selecionado' : ''}${i.id === estado.painel ? ' no-painel' : ''}">
    <td class="col-n mono suave">${i.n_item}</td>
    <td class="col-prod">
      <div class="prod-nome" title="${esc(nome)}">${esc(nome)}${i.marcas?.produtoNovo ? ' <span class="chip chip-amarelo chip-mini" title="Primeira vez que este produto vem deste fornecedor">novo</span>' : ''}${
        avisos.length && !i.revisado ? ` <span class="marca-aviso marca-${avisos.some((a) => a.severidade === 'critico') ? 'vermelho' : 'amarelo'}" title="${esc(avisos.map((a) => a.titulo).join(' · '))}">${avisos.some((a) => a.severidade === 'critico') ? '▲' : '●'} ${esc(avisos[0].titulo)}${avisos.length > 1 ? ` +${avisos.length - 1}` : ''}</span>` : ''}</div>
      <div class="prod-info">cód. ${esc(i.c_prod ?? '—')} · NCM ${esc(i.ncm ?? '—')}${i.x_prod_novo && i.x_prod_novo !== i.x_prod_original ? ` · na nota: ${esc(i.x_prod_original)}` : ''}</div>
    </td>
    <td class="col-cfop-o mono">${cfopForaDoNormal ? `<span class="chip chip-amarelo chip-mini" title="O normal é 5102. Este CFOP de saída é outro: confira o tratamento.">${esc(i.cfop_original)}</span>` : esc(i.cfop_original ?? '')}</td>
    <td class="col-cfop"><input class="cfop" inputmode="numeric" maxlength="4" value="${esc(i.cfop_novo ?? '')}" data-campo="cfop" data-valor="${esc(i.cfop_novo ?? '')}"
      aria-label="CFOP de entrada do item ${i.n_item}" title="${esc(descricaoCfop(i.cfop_novo))}"${podeEditar() ? '' : ' disabled'}></td>
    <td class="col-origem">${o ? `<span class="chip chip-${o.cor}" title="${esc(o.dica)}">${esc(o.texto)}</span>` : ''}</td>
    <td class="col-valor num">${n().nota.cancelada_em ? '0,00' : i.valores_lidos === 1 && i.valor_contabil != null
      ? `<span title="${esc(composicaoContabil(i))}">${moeda(i.valor_contabil)}</span>` : moeda(i.valor_total)}</td>
    <td class="col-sit"><span class="estado estado-${st.cor}">${st.cor === 'verde' ? '✓ ' : ''}${esc(st.texto)}</span></td>
    <td class="col-acao">${!i.revisado && podeEditar()
      ? `<button type="button" class="btn-conferir" data-conferir="${esc(i.id)}" title="Conferir este item (Ctrl+Enter)"${conferindo ? ' disabled' : ''}>${conferindo ? '…' : '✓'}</button>` : ''}</td>
  </tr>`;
}

/** Redesenha os itens sem perder o que a pessoa está digitando nem onde está o cursor. */
function desenharTabela() {
  desenharAbas();
  const ativo = document.activeElement;
  const emEdicao = ativo?.matches?.('#itens input') ? {
    id: ativo.closest('tr').dataset.item, campo: ativo.dataset.campo, valor: ativo.value,
    sujo: ativo.value !== ativo.dataset.valor, ini: ativo.selectionStart, fim: ativo.selectionEnd,
  } : null;
  const lista = itensVisiveis();
  $('#itens').innerHTML = lista.length ? lista.map(linhaItem).join('')
    : `<tr><td colspan="8" class="vazio">${estado.buscaItens ? `Nenhum item com “${esc(estado.buscaItens)}”.`
      : estado.filtroItens === 'faltam' ? '✓ Nenhum item falta conferir nesta nota.' : 'Nenhum item aqui.'}
      ${estado.filtroItens !== 'todos' || estado.buscaItens ? '<button type="button" class="link" id="ver-todos">Ver todos os itens</button>' : ''}</td></tr>`;
  $('#ver-todos')?.addEventListener('click', () => { estado.filtroItens = 'todos'; estado.buscaItens = ''; $('#filtro-itens').value = ''; desenharTabela(); });
  if (emEdicao) {
    const inp = $(`tr[data-item="${CSS.escape(emEdicao.id)}"] input[data-campo="${emEdicao.campo}"]`);
    if (inp) {
      if (emEdicao.sujo) inp.value = emEdicao.valor;
      inp.focus();
      try { inp.setSelectionRange(emEdicao.ini, emEdicao.fim); } catch { /* sem seleção: segue */ }
    }
  }
}

function marcarSelecionado(id) {
  if (estado.selecionado === id) return;
  estado.selecionado = id;
  $$('#itens tr.selecionado').forEach((tr) => tr.classList.remove('selecionado'));
  $(`#itens tr[data-item="${CSS.escape(id)}"]`)?.classList.add('selecionado');
  if (estado.painel && estado.painel !== id) { estado.painel = id; desenharPainel(); }
}

function desenharTotais() {
  const t = n().totaisCfop;
  const el = $('#totais');
  if (!t?.linhas?.length) { el.hidden = true; return; }
  el.hidden = false;
  if (t.cancelada) { el.innerHTML = '<summary>Total por CFOP desta nota <span class="chip chip-cinza">nota cancelada · vale zero</span></summary>'; return; }
  const fecha = Math.abs(t.diferenca) < 0.005;
  const temSt = t.linhas.some((l) => Number(l.st) > 0);
  const temIpi = t.linhas.some((l) => Number(l.ipi) > 0);
  el.innerHTML = `<summary>Total por CFOP desta nota ${!t.valoresLidos ? '<span class="chip chip-amarelo">valor contábil incompleto</span>'
      : fecha ? `<span class="chip chip-verde">fecha com o total da nota · R$ ${moeda(t.valorNota)}</span>`
      : `<span class="chip chip-vermelho">difere do total da nota em R$ ${moeda(t.diferenca)}</span>`}</summary>
    <table class="tabela tabela-totais"><thead><tr><th>CFOP de entrada</th><th class="num">Itens</th><th class="num">Valor dos produtos</th><th class="num">Valor contábil</th>
      <th class="num">Base ICMS</th><th class="num">ICMS</th>${temSt ? '<th class="num">ICMS ST</th>' : ''}${temIpi ? '<th class="num">IPI</th>' : ''}</tr></thead>
    <tbody>${t.linhas.map((l) => `<tr><td><b class="mono">${esc(l.cfop)}</b> <span class="suave">${esc(l.natureza ?? descricaoCfop(l.cfop))}</span></td>
      <td class="num">${l.itens}</td><td class="num">${moeda(l.valor)}</td><td class="num"><b>${moeda(l.valorContabil)}</b></td>
      <td class="num">${moeda(l.baseIcms)}</td><td class="num">${moeda(l.icms)}</td>${temSt ? `<td class="num">${moeda(l.st)}</td>` : ''}${temIpi ? `<td class="num">${moeda(l.ipi)}</td>` : ''}</tr>`).join('')}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${t.totais.itens}</td><td class="num">${moeda(t.totais.valor)}</td><td class="num">${moeda(t.totais.valorContabil)}</td>
      <td class="num">${moeda(t.totais.baseIcms ?? 0)}</td><td class="num">${moeda(t.totais.icms ?? 0)}</td>${temSt ? `<td class="num">${moeda(t.totais.st ?? 0)}</td>` : ''}${temIpi ? `<td class="num">${moeda(t.totais.ipi ?? 0)}</td>` : ''}</tr></tfoot></table>`;
}

/* ------------------------------------------------------------ tabela: cliques e teclado */

function cliqueNaTabela(ev) {
  const c = ev.target.closest('[data-conferir]');
  if (c) return conferirUm(c.dataset.conferir);
  if (ev.target.closest('input, button, a')) return;
  const tr = ev.target.closest('tr[data-item]');
  if (tr) abrirPainel(tr.dataset.item);
}

function mudouCampo(ev) {
  const inp = ev.target.closest('input[data-campo]');
  if (!inp) return;
  const id = inp.closest('tr').dataset.item;
  salvar(id, inp.dataset.campo, inp.value.trim(), inp);
}

function teclaNaTabela(ev) {
  const tr = ev.target.closest('tr[data-item]');
  if (!tr) return;
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); if (!item(tr.dataset.item)?.revisado) conferirUm(tr.dataset.item, true); return; }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Enter') {
    ev.preventDefault();
    const inp = ev.target.closest('input');
    if (inp && inp.value.trim() !== inp.dataset.valor) inp.blur(); // grava (change) antes de sair
    irPara(tr, ev.key === 'ArrowUp' ? -1 : 1);
  }
}

function irPara(tr, passo) {
  const linhas = $$('#itens tr[data-item]');
  const k = linhas.indexOf(tr) + passo;
  const alvo = linhas[Math.max(0, Math.min(linhas.length - 1, k))];
  if (!alvo) return;
  const inp = alvo.querySelector('input.cfop');
  if (inp && !inp.disabled) { inp.focus(); inp.select(); } else { alvo.setAttribute('tabindex', '-1'); alvo.focus(); }
  marcarSelecionado(alvo.dataset.item);
  alvo.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && estado.painel && !$('#dialogo').open) fecharPainel();
});

/* ------------------------------------------------------------ gravar */

async function salvar(id, campo, valor, inp = null) {
  const i = item(id);
  if (!i) return;
  const atual = campo === 'cfop' ? (i.cfop_novo ?? '') : (i.x_prod_novo ?? '');
  if (String(valor) === String(atual)) return;
  try {
    await enviar(`/api/itens/${id}`, { mudancas: [{ campo, valor }] }, 'PATCH');
    aviso(campo === 'cfop' ? `CFOP ${valor} gravado` : 'Nome gravado');
    await recarregar();
    atualizarDepoisDeGravar().catch(() => {});
  } catch (e) {
    if (inp) { inp.value = atual; inp.dataset.valor = atual; }
    avisoErro(e, 'Não gravou: ');
  }
}

/* Conferir um item sem travar a tela: a linha muda na hora e a nota recarrega quando o último terminar. */
async function conferirUm(id, irProximo = false) {
  if (estado.conferindo.has(id)) return;
  const tr = $(`#itens tr[data-item="${CSS.escape(id)}"]`);
  // Antes de conferir, grava o CFOP que ainda estiver sendo digitado nesta linha.
  const inp = tr?.querySelector('input.cfop');
  if (inp && inp.value.trim() !== inp.dataset.valor) await salvar(id, 'cfop', inp.value.trim(), inp);
  if (irProximo && tr) irPara(tr, 1);
  estado.conferindo.add(id);
  desenharTabela();
  desenharCabeca();
  let erro = null;
  try { await enviar(`/api/notas/${n().nota.id}/conferir`, { itens: [id] }); } catch (e) { erro = e; } finally { estado.conferindo.delete(id); }
  if (erro) avisoErro(erro, 'Não conferiu: ');
  if (estado.conferindo.size === 0) {
    await recarregar().catch(() => {});
    atualizarDepoisDeGravar().catch(() => {});
  }
}

async function conferir(ids) {
  if (!ids.length) return;
  try {
    const r = await comEspera(enviar(`/api/notas/${n().nota.id}/conferir`, { itens: ids }));
    aviso(r.conferidos === 1 ? '1 item conferido' : `${r.conferidos} itens conferidos`);
    await recarregar();
    await atualizarDepoisDeGravar();
    desenharCabeca();
  } catch (e) { avisoErro(e, 'Não conferiu: '); }
}

async function conferirResto(faltam) {
  const palpite = faltam.filter((i) => ['perfil', 'parecido'].includes(i.procedencia?.fonte) || i.procedencia?.regraAgora).length;
  const comAviso = faltam.filter((i) => (i.alertas ?? []).some((a) => a.severidade === 'critico' || a.severidade === 'atencao')).length;
  const semCfop = faltam.filter((i) => !String(i.cfop_novo ?? '').trim()).length;
  if (semCfop) return aviso(`${plural(semCfop, 'item está', 'itens estão')} sem CFOP de entrada. Preencha antes de conferir.`, 'erro');
  const ok = await confirmar({
    titulo: `Conferir ${plural(faltam.length, 'item', 'itens')} como ${faltam.length === 1 ? 'está' : 'estão'}`,
    ok: `Conferir ${faltam.length}`,
    corpo: `<p>Você confirma que olhou e concorda com o CFOP de cada um.</p>
      ${palpite || comAviso ? `<ul class="lista-alerta">
        ${palpite ? `<li>${plural(palpite, 'item veio', 'itens vieram')} de palpite ou de outro produto</li>` : ''}
        ${comAviso ? `<li>${plural(comAviso, 'item tem', 'itens têm')} aviso</li>` : ''}</ul>` : ''}
      <p class="suave">Conferir também ensina: o CFOP de cada item vira o padrão daquele produto.</p>`,
  });
  if (ok) await conferir(faltam.map((i) => i.id));
}

/* ------------------------------------------------------------ "Mais" */

function menuMais(ev) {
  const nota = n().nota;
  const ops = [];
  if (podeEditar()) {
    ops.push(['aplicar', 'Aplicar um CFOP em todos os itens…']);
    if (pode('regras.fixar')) ops.push(['padrao-todos', 'Salvar o CFOP de cada item como padrão do produto…']);
  }
  ops.push(['pdf', 'PDF da nota (DANFE)'], ['imprimir', 'Imprimir como ficou']);
  ops.push(['original', 'Nota original e XML do fornecedor ↗']);
  if (pode('notas.importar') && Number(nota.estorno) !== 1) ops.push(['cancelada', nota.cancelada_em ? 'Desfazer cancelamento…' : 'Marcar como cancelada…']);
  ops.push(['antiga', 'Abrir esta nota na tela de sempre ↗']);
  abrirMenu(ev.currentTarget, `<div class="menu-lista">${ops.map(([k, r]) => `<button type="button" class="menu-op" data-op="${k}">${esc(r)}</button>`).join('')}</div>`, (op) => {
    if (op === 'aplicar') return aplicarEmTodos();
    if (op === 'padrao-todos') return padraoDeTodos();
    if (op === 'pdf') return window.open(`/api/notas/${nota.id}/danfe`, '_blank', 'noopener');
    if (op === 'imprimir') return window.print();
    if (op === 'original') { location.href = linkTelaAntiga('vOriginal', nota.id); return; }
    if (op === 'cancelada') return alternarCancelada();
    if (op === 'antiga') { location.href = linkTelaAntiga('v2', nota.id); }
  }, { largura: '340px' });
}

async function aplicarEmTodos() {
  const itens = n().itens;
  const ok = await confirmar({
    titulo: 'Aplicar um CFOP em todos os itens',
    ok: 'Aplicar',
    corpo: `<label class="campo">CFOP de entrada
        <select id="cfop-todos">${CFOPS.map(([c, d]) => `<option value="${c}">${c} — ${esc(d)}</option>`).join('')}</select></label>
      ${pode('regras.fixar') ? `<label class="marcar"><input type="checkbox" id="fixar-forn"> Fixar também como padrão <b>deste fornecedor</b> (vale para qualquer produto dele, inclusive os que ainda não vieram)</label>` : ''}
      <p class="suave">Troca o CFOP dos ${itens.length} itens desta nota, inclusive os já conferidos.</p>`,
  });
  if (!ok) return;
  const cfop = $('#cfop-todos')?.value ?? '';
  const escopo = $('#fixar-forn')?.checked ? 'fornecedor' : 'item';
  try {
    await comEspera((async () => {
      for (let k = 0; k < itens.length; k += 200) {
        await enviar(`/api/notas/${n().nota.id}/aplicar-cfop`, { cfop, itens: itens.slice(k, k + 200).map((i) => i.id), escopo });
      }
    })());
    aviso(`${cfop} aplicado em ${plural(itens.length, 'item', 'itens')}`);
    await recarregar();
    atualizarDepoisDeGravar().catch(() => {});
  } catch (e) { avisoErro(e, 'Não aplicou: '); }
}

async function padraoDeTodos() {
  const alvos = n().itens.filter((i) => String(i.cfop_novo ?? '').trim() && i.procedencia?.fonte !== 'fixada');
  if (!alvos.length) return aviso('Nenhum item para salvar: ou já são padrão, ou estão sem CFOP.', 'erro');
  const ok = await confirmar({
    titulo: 'Salvar o padrão de cada produto',
    ok: `Salvar ${alvos.length}`,
    corpo: `<p>${plural(alvos.length, 'item terá', 'itens terão')} o seu CFOP salvo como padrão daquele produto, deste fornecedor.</p>
      <p class="suave">Nenhum valor muda agora. A próxima nota deste fornecedor já vem com eles preenchidos.</p>`,
  });
  if (!ok) return;
  try {
    const r = await comEspera(enviar(`/api/notas/${n().nota.id}/fixar-padrao`, { itens: alvos.map((i) => i.id) }));
    aviso(`${plural(r.fixados, 'padrão salvo', 'padrões salvos')}`);
    await recarregar();
  } catch (e) { avisoErro(e, 'Não salvou: '); }
}

async function alternarCancelada() {
  const nota = n().nota;
  const cancelar = !nota.cancelada_em;
  const ok = await confirmar({
    titulo: cancelar ? 'Marcar como cancelada' : 'Desfazer cancelamento',
    ok: cancelar ? 'Marcar como cancelada' : 'Desfazer',
    perigo: cancelar,
    corpo: cancelar ? '<p>A nota fica na lista com a chave, mas vale zero: sai das somas, dos relatórios e do XML corrigido.</p>'
      : '<p>A nota volta a valer o que está no XML.</p>',
  });
  if (!ok) return;
  try {
    await enviar(`/api/notas/${nota.id}/cancelada`, { cancelada: cancelar });
    await recarregar();
    desenharAvisos();
    desenharTotais();
    atualizarDepoisDeGravar().catch(() => {});
  } catch (e) { avisoErro(e, 'Não gravou: '); }
}

/* ------------------------------------------------------------ painel do item */

function abrirPainel(id) {
  estado.painel = id;
  marcarSelecionado(id);
  desenharPainel();
}

function fecharPainel() {
  estado.painel = null;
  $('#painel').hidden = true;
  document.body.classList.remove('com-painel');
  $$('#itens tr.no-painel').forEach((tr) => tr.classList.remove('no-painel'));
}

function desenharPainel() {
  const i = item(estado.painel);
  if (!i) return fecharPainel();
  $$('#itens tr.no-painel').forEach((tr) => tr.classList.remove('no-painel'));
  $(`#itens tr[data-item="${CSS.escape(i.id)}"]`)?.classList.add('no-painel');
  document.body.classList.add('com-painel');
  const p = $('#painel');
  p.hidden = false;
  const o = origemDoCfop(i.procedencia);
  const st = estadoDaLinha(i);
  const nome = i.x_prod_novo || i.x_prod_original;
  const podeFixar = pode('regras.fixar') && podeEditar() && String(i.cfop_novo ?? '').trim() && i.procedencia?.fonte !== 'fixada';
  p.innerHTML = `
    <header class="painel-cabeca">
      <div>
        <p class="painel-sobre">Item ${i.n_item} de ${n().itens.length} · <span class="estado estado-${st.cor}">${st.cor === 'verde' ? '✓ ' : ''}${esc(st.texto)}</span></p>
        <h2>${esc(nome)}</h2>
        ${i.x_prod_novo && i.x_prod_novo !== i.x_prod_original ? `<p class="suave">Na nota do fornecedor: ${esc(i.x_prod_original)}</p>` : ''}
        <p class="suave">cód. ${esc(i.c_prod ?? '—')}${i.c_ean ? ` · EAN ${esc(i.c_ean)}` : ''} · NCM ${esc(i.ncm ?? '—')} · ${esc(String(i.quantidade ?? ''))} ${esc(i.unidade ?? '')} × ${moeda(i.valor_unitario)}</p>
      </div>
      <button type="button" class="fechar" id="fechar-painel" title="Fechar (Esc)" aria-label="Fechar">×</button>
    </header>

    <section class="painel-bloco">
      <label class="campo">CFOP de entrada
        <span class="linha-campo">
          <input class="cfop cfop-grande" id="painel-cfop" inputmode="numeric" maxlength="4" list="lista-cfops" value="${esc(i.cfop_novo ?? '')}"${podeEditar() ? '' : ' disabled'}>
          <span class="suave" id="painel-cfop-desc">${esc(descricaoCfop(i.cfop_novo))}</span>
        </span>
      </label>
      <p class="suave">Saída do fornecedor: <b class="mono">${esc(i.cfop_original ?? '—')}</b>${i.marcas?.cfopForaDoNormal ? ' <span class="chip chip-amarelo chip-mini">diferente de 5102</span>' : ''}</p>
      ${o ? `<div class="origem"><span class="chip chip-${o.cor}">${esc(o.texto)}</span> <span>${esc(o.dica)}</span>
        ${['aprendida', 'fixada', 'parecido'].includes(i.procedencia?.fonte) || i.procedencia?.regraAgora ? '<button type="button" class="link" id="ver-de-onde">De onde veio?</button>' : ''}</div>` : ''}
      <div id="de-onde"></div>
      ${podeFixar ? `<button type="button" class="btn sutil" id="fixar-produto" title="O CFOP desta linha vira o padrão deste produto deste fornecedor, já confiável na próxima nota">Fixar ${esc(i.cfop_novo)} como padrão deste produto</button>` : ''}
    </section>

    ${(i.alertas ?? []).length ? `<section class="painel-bloco"><h3>Avisos</h3>
      ${i.alertas.map((a) => `<div class="alerta alerta-${a.severidade === 'critico' ? 'vermelho' : a.severidade === 'atencao' ? 'amarelo' : 'azul'}">
        <b>${esc(a.titulo)}</b><span>${esc(a.detalhe ?? '')}</span></div>`).join('')}
      ${i.revisado ? '<p class="suave">Visto e conferido: o aviso fica como registro.</p>' : ''}</section>` : ''}

    <section class="painel-bloco">
      <label class="campo">Nome no XML corrigido
        <input id="painel-nome" value="${esc(i.x_prod_novo ?? '')}" placeholder="${esc(i.x_prod_original)}"${pode('notas.editar_descricao') && !fechada() ? '' : ' disabled'}>
      </label>
      <p class="suave">Vale só para este produto deste fornecedor. Igual ao do fornecedor = sem mudança.</p>
    </section>

    <section class="painel-bloco painel-valores">
      <h3>Valores</h3>
      <dl>
        <dt>Valor do produto</dt><dd>R$ ${moeda(i.valor_total)}</dd>
        <dt>Valor contábil</dt><dd>${i.valores_lidos === 1 && i.valor_contabil != null ? `R$ ${moeda(i.valor_contabil)} <small class="suave bloco">${esc(composicaoContabil(i))}</small>` : '—'}</dd>
        <dt>Base ICMS</dt><dd>R$ ${moeda(i.v_bc_icms ?? 0)}</dd>
        <dt>ICMS</dt><dd>R$ ${moeda(i.v_icms ?? 0)}</dd>
      </dl>
    </section>

    ${pode('auditoria.visualizar') ? '<section class="painel-bloco"><h3>Como estava</h3><div id="trilha" class="suave">carregando…</div></section>' : ''}

    <footer class="painel-rodape">
      ${!podeEditar() ? '' : i.revisado
        ? `<span class="suave">Conferido${i.revisado_por_nome ? ` por ${esc(i.revisado_por_nome)}` : ''}${i.revisado_em ? ` em ${dataCurta(i.revisado_em)}` : ''}</span>
           <button type="button" class="btn" id="desconferir">Desfazer conferência</button>`
        : `<button type="button" class="btn primario" id="conferir-painel">✓ Conferir</button>`}
      <button type="button" class="btn sutil" id="proximo-item">Próximo item ↓</button>
    </footer>`;

  $('#fechar-painel').addEventListener('click', fecharPainel);
  const cf = $('#painel-cfop');
  cf.addEventListener('input', () => { $('#painel-cfop-desc').textContent = descricaoCfop(cf.value); });
  cf.addEventListener('change', () => salvar(i.id, 'cfop', cf.value.trim(), cf));
  cf.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); cf.blur(); } });
  const nm = $('#painel-nome');
  nm.addEventListener('change', () => salvar(i.id, 'descricao', nm.value.trim(), nm));
  nm.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); nm.blur(); } });
  $('#ver-de-onde')?.addEventListener('click', () => deOndeVeio(i));
  $('#fixar-produto')?.addEventListener('click', () => fixarProduto(i));
  $('#conferir-painel')?.addEventListener('click', () => conferirUm(i.id));
  $('#desconferir')?.addEventListener('click', () => desconferir(i.id));
  $('#proximo-item').addEventListener('click', () => {
    const tr = $(`#itens tr[data-item="${CSS.escape(i.id)}"]`);
    if (tr) { irPara(tr, 1); abrirPainel(estado.selecionado); }
  });
  if (pode('auditoria.visualizar')) carregarTrilha(i);
}

async function deOndeVeio(i) {
  const caixa = $('#de-onde');
  caixa.innerHTML = '<p class="suave">procurando…</p>';
  let r;
  try { r = await api(`/api/itens/${i.id}/de-onde-veio`); } catch (e) { caixa.innerHTML = `<p class="suave">Não consegui ver: ${esc(e.message)}</p>`; return; }
  if (!r.regra) { caixa.innerHTML = '<p class="suave">Este CFOP não veio de uma regra aprendida: foi digitado ou é palpite.</p>'; return; }
  const g = r.regra;
  const deOutro = g.nivel === 4 || g.nivel === 6;
  const valorLinha = String(i.cfop_novo ?? '').trim();
  const difere = valorLinha && valorLinha !== String(g.valor).trim();
  caixa.innerHTML = `<div class="de-onde">
    <p>A regra diz <b class="mono">${esc(g.valor)}</b>${deOutro ? ', aprendida de <b>outro produto</b> com o mesmo NCM' : g.nivel === 5 ? ', do padrão do fornecedor' : ', aprendida neste produto'}${g.fixada ? ' · <b>fixada</b>' : ''}.
      ${Number(g.usos) > 0 ? `<span class="suave">Usada ${g.usos}x${Number(g.erros) > 0 ? `, corrigida ${g.erros}x` : ''}.</span>` : ''}</p>
    ${difere ? `<p class="nota-aviso">Esta linha está em <b>${esc(valorLinha)}</b>, mas a regra hoje diz <b>${esc(g.valor)}</b>. ${i.revisado ? 'Linha conferida não muda sozinha: se o certo é o da regra, troque aqui.' : ''}</p>` : ''}
    ${r.decisoes.length ? `<table class="tabela tabela-mini"><tbody>${r.decisoes.slice(0, 8).map((d) => `
      <tr class="${String(d.cfop_novo).trim() === String(g.valor).trim() ? '' : 'suave'}">
        <td>${dataCurta(d.dh_emi)}</td><td class="mono">NF ${esc(d.numero ?? '')}</td>
        <td>${esc(d.x_prod_novo || d.x_prod_original || '')}</td><td class="mono"><b>${esc(d.cfop_novo)}</b></td>
        <td><a href="${endereco({ t: 'nota', n: d.nota_id, i: d.item_id })}">abrir</a></td></tr>`).join('')}</tbody></table>
      ${r.decisoes.length > 8 ? `<p class="suave">e mais ${r.decisoes.length - 8}.</p>` : ''}` : '<p class="suave">Nenhuma nota tratada bate com esta regra.</p>'}
  </div>`;
}

async function carregarTrilha(i) {
  let eventos;
  try { eventos = await api(`/api/itens/${i.id}/trilha`); } catch (e) { $('#trilha').textContent = `Não consegui ler: ${e.message}`; return; }
  if (estado.painel !== i.id) return;
  const anterior = eventos.find((e) => e.campo === 'cfop' && e.valor_antes);
  $('#trilha').innerHTML = eventos.length === 0 ? 'Nada mudou neste item desde que a nota entrou.'
    : `<ul class="trilha">${eventos.map((e) => `<li><span class="mono">${dataCurta(e.quando)}</span>
        <span>${esc(ROTULO_CAMPO[e.campo] ?? e.campo ?? e.acao)}:
        ${e.campo === 'conferido' ? 'conferido' : `${e.valor_antes ? `<s>${esc(e.valor_antes)}</s> → ` : ''}<b>${esc(e.valor_depois ?? '—')}</b>`}</span>
        <span class="suave">${esc(e.usuario_email ?? '')}${e.origem === 'correcao:nome-de-outro-produto' ? ' · correção: o nome tinha vindo de outro produto' : ''}</span></li>`).join('')}</ul>
      ${anterior && podeEditar() ? `<button type="button" class="btn sutil" id="voltar-cfop">Voltar o CFOP para ${esc(anterior.valor_antes)}</button>` : ''}`;
  $('#voltar-cfop')?.addEventListener('click', () => salvar(i.id, 'cfop', anterior.valor_antes));
}

async function fixarProduto(i) {
  const ok = await confirmar({
    titulo: 'Fixar como padrão deste produto',
    ok: 'Fixar padrão',
    corpo: `<p>O CFOP <b>${esc(i.cfop_novo)}</b> passa a ser o padrão de <b>${esc(i.x_prod_novo || i.x_prod_original)}</b>, só deste fornecedor.</p>
      <p class="suave">A próxima nota já vem com ele preenchido. Não muda nenhum outro item desta nota.</p>`,
  });
  if (!ok) return;
  try {
    await enviar(`/api/itens/${i.id}`, { mudancas: [{ campo: 'cfop', valor: String(i.cfop_novo).trim() }], fixar: true }, 'PATCH');
    aviso('Padrão fixado');
    await recarregar();
  } catch (e) { avisoErro(e, 'Não fixou: '); }
}

async function desconferir(id) {
  try {
    await enviar(`/api/itens/${id}/desconferir`, {});
    aviso('Voltou para a conferir');
    await recarregar();
    atualizarDepoisDeGravar().catch(() => {});
  } catch (e) { avisoErro(e, 'Não desfez: '); }
}

/* Para a impressão: cabeçalho com empresa e chave (a folha sai sem botões). */
window.addEventListener('beforeprint', () => {
  const a = n();
  if (!a || !$('#cabeca-nota')) return;
  let folha = $('#folha-impressao');
  if (!folha) { folha = document.createElement('div'); folha.id = 'folha-impressao'; $('#tela').prepend(folha); }
  folha.innerHTML = `<b>NF ${esc(a.nota.numero)}</b> · ${esc(a.nota.emit_nome ?? '')} · CNPJ ${esc(cnpjFormatado(a.nota.emit_cnpj))} · emissão ${dataCurta(a.nota.dh_emi)}
    <br><span class="suave">Chave ${esc(a.nota.chave ?? '')} · impresso em ${new Date().toLocaleString('pt-BR')} por ${esc(estado.eu?.nome ?? '')}</span>`;
  $('#totais')?.setAttribute('open', '');
});
