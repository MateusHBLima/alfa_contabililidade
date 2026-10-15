/* Alfa Fiscal v2 — tela Notas: abre direto na lista, com o que precisa dela primeiro. */

import { api, enviar } from './api.js';
import { $, $$, esc, moeda, dataCurta, nomeCompetencia, plural, notaTratada, notaVeioPronta,
  notaPrecisaDeVoce, valorQueConta, itensQueVieramCertos, origemDoCfop, cnpjFormatado } from './util.js';
import { estado, endereco, linkTelaAntiga, pode } from './estado.js';
import { abrirMenu, aviso, avisoErro, confirmar, informar, comEspera } from './ui.js';
import { atualizarDepoisDeGravar } from './app.js';

const ABAS = [
  ['precisam', 'Precisam de você', notaPrecisaDeVoce],
  ['prontas', 'Vieram prontas', notaVeioPronta],
  ['tratadas', 'Tratadas', notaTratada],
  ['todas', 'Todas', () => true],
];

let buscaAtual = '';

export async function telaNotas() {
  document.title = 'Notas · Alfa Fiscal';
  const noPeriodo = notasDoPeriodo();
  // Abre na aba onde há trabalho: primeiro o que precisa dela, depois o que veio pronto.
  if (!estado.aba) {
    estado.aba = noPeriodo.some(notaPrecisaDeVoce) ? 'precisam' : noPeriodo.some(notaVeioPronta) ? 'prontas' : 'todas';
  }
  $('#tela').innerHTML = `
    <div class="cabeca">
      <div>
        <h1>Notas <span class="h1-sub">${esc(nomeCompetencia(estado.competencia))}</span></h1>
        <p class="resumo" id="resumo-notas"></p>
      </div>
      <form class="busca-topo" id="form-busca" role="search">
        <input type="search" id="busca-produto" placeholder="Procurar produto, fornecedor, código ou nº da nota" autocomplete="off" value="${esc(buscaAtual)}">
        <button type="submit" class="btn">Procurar</button>
      </form>
      <a class="btn primario" href="${linkTelaAntiga('v1')}" title="Por enquanto a importação é feita na tela de sempre">Importar XML <span class="seta-fora">↗</span></a>
    </div>
    <div id="avisos-notas"></div>
    <div id="area-notas"></div>`;

  $('#form-busca').addEventListener('submit', (ev) => { ev.preventDefault(); procurar($('#busca-produto').value); });
  $('#busca-produto').addEventListener('search', (ev) => { if (!ev.target.value) procurar(''); });
  if (buscaAtual) await procurar(buscaAtual);
  else desenharLista();
}

/* ------------------------------------------------------------ lista */

function notasDoPeriodo() {
  const { de, ate } = estado.periodo;
  const dia = (n) => String(n.dh_emi ?? '').slice(0, 10);
  return estado.notas.filter((n) => (!de || dia(n) >= de) && (!ate || dia(n) <= ate));
}

function desenharLista() {
  const noPeriodo = notasDoPeriodo();
  const contagem = Object.fromEntries(ABAS.map(([k, , f]) => [k, noPeriodo.filter(f).length]));
  const visiveis = noPeriodo.filter(ABAS.find(([k]) => k === estado.aba)[2]);

  // Uma linha de resumo no lugar dos cinco quadros.
  const itens = noPeriodo.reduce((s, n) => s + (n.total_itens ?? 0), 0);
  const conferidos = noPeriodo.reduce((s, n) => s + (n.itens_revisados ?? 0), 0);
  const valor = noPeriodo.reduce((s, n) => s + valorQueConta(n), 0);
  const fornecedores = new Set(noPeriodo.map((n) => n.emit_cnpj)).size;
  $('#resumo-notas').innerHTML = noPeriodo.length
    ? `${plural(noPeriodo.length, 'nota', 'notas')} · ${plural(fornecedores, 'fornecedor', 'fornecedores')} · ${conferidos} de ${plural(itens, 'item conferido', 'itens conferidos')} · R$ ${moeda(valor)}`
    : '';

  desenharAvisos(noPeriodo, contagem);

  const { de, ate } = estado.periodo;
  const textoPeriodo = de || ate ? `${de ? dataCurta(de) : 'início'} a ${ate ? dataCurta(ate) : 'hoje'}` : 'qualquer data';
  $('#area-notas').innerHTML = `
    <div class="barra">
      <div class="abas" role="tablist">${ABAS.map(([k, rot]) => `
        <button type="button" role="tab" class="aba${estado.aba === k ? ' ativa' : ''}" data-aba="${k}" aria-selected="${estado.aba === k}">
          ${rot} <span class="aba-num">${contagem[k]}</span></button>`).join('')}
      </div>
      <div class="barra-dir">
        <button type="button" class="btn sutil${de || ate ? ' com-filtro' : ''}" id="btn-periodo" aria-haspopup="true">Emissão: ${esc(textoPeriodo)} ▾</button>
        <button type="button" class="btn sutil${estado.agrupar ? ' com-filtro' : ''}" id="btn-agrupar" aria-pressed="${estado.agrupar}">Agrupar por fornecedor</button>
      </div>
    </div>
    ${estado.aba === 'prontas' && visiveis.length ? `
      <div class="faixa-acao">
        <span><b>${plural(visiveis.length, 'nota veio pronta', 'notas vieram prontas')}:</b> todos os itens que faltam vêm do que vocês ensinaram para o próprio produto. Veja os itens (▸) e confira.</span>
        <button type="button" class="btn primario" id="btn-conferir-prontas">Conferir as ${visiveis.length}</button>
      </div>` : ''}
    <div class="tabela-caixa">${visiveis.length ? tabelaNotas(visiveis) : vazio(noPeriodo, contagem)}</div>`;

  $$('[data-aba]').forEach((b) => b.addEventListener('click', () => { estado.aba = b.dataset.aba; desenharLista(); }));
  $('#btn-periodo').addEventListener('click', menuPeriodo);
  $('#btn-agrupar').addEventListener('click', () => { estado.agrupar = !estado.agrupar; desenharLista(); });
  $('#btn-conferir-prontas')?.addEventListener('click', () => conferirProntas(visiveis.map((n) => n.id)));
  $('#area-notas').onclick = cliqueNaLista;
}

function vazio(noPeriodo, contagem) {
  if (estado.notas.length === 0) return `<div class="vazio">Nenhuma nota em ${esc(nomeCompetencia(estado.competencia))}.</div>`;
  if (noPeriodo.length === 0) return '<div class="vazio">Nenhuma nota emitida nesse período.</div>';
  if (estado.aba === 'precisam') {
    return contagem.prontas
      ? `<div class="vazio vazio-bom">Nenhuma nota precisa de você. <button type="button" class="link" data-aba-ir="prontas">${plural(contagem.prontas, 'nota veio pronta', 'notas vieram prontas')} →</button></div>`
      : '<div class="vazio vazio-bom">✓ Tudo tratado neste mês.</div>';
  }
  if (estado.aba === 'prontas') return '<div class="vazio">Nenhuma nota veio pronta.</div>';
  return '<div class="vazio">Nenhuma nota aqui.</div>';
}

function desenharAvisos(noPeriodo, contagem) {
  const partes = [];
  // Pendência em outro mês da mesma empresa: não pode ficar escondida pelo mês escolhido.
  const pend = estado.pendencias.find((p) => p.empresaId === estado.empresaId);
  const aquiFaltam = estado.notas.filter((n) => !notaTratada(n)).length;
  if (estado.competencia && pend && pend.notas > aquiFaltam) {
    const fora = pend.notas - aquiFaltam;
    partes.push(`<div class="nota-aviso">Há ${plural(fora, 'nota a tratar', 'notas a tratar')} em outros meses desta empresa.
      <a href="${endereco({ t: 'notas', m: 'todos' })}">Ver todos os meses</a></div>`);
  }
  // Estornos: saída que veio como entrada, para lançar à mão.
  const estornos = noPeriodo.filter((n) => Number(n.estorno) === 1 && !n.cancelada_em);
  if (estornos.length) {
    partes.push(`<div class="nota-aviso nota-aviso-forte"><b>↩ ${plural(estornos.length, 'nota de estorno', 'notas de estorno')}</b>:
      ${estornos.length === 1 ? 'veio como entrada e é saída' : 'vieram como entrada e são saídas'} da empresa. Lançar à mão nas saídas:
      ${estornos.map((n) => `<a href="${endereco({ t: 'nota', n: n.id })}">NF ${esc(n.numero)}</a>`).join(', ')}.</div>`);
  }
  // Outras empresas com trabalho: uma linha discreta, clicável.
  const outras = estado.pendencias.filter((p) => p.empresaId !== estado.empresaId);
  if (outras.length && !contagem.precisam) {
    partes.push(`<div class="nota-aviso nota-aviso-suave">Outras empresas com notas a tratar:
      ${outras.map((p) => `<a href="${endereco({ t: 'notas', e: p.empresaId, m: null })}">${esc(p.razaoSocial)} (${p.notas})</a>`).join(' · ')}</div>`);
  }
  $('#avisos-notas').innerHTML = partes.join('');
}

function situacao(n) {
  const total = n.total_itens ?? 0;
  const feitos = n.itens_revisados ?? 0;
  if (n.cancelada_em) return '<span class="chip chip-cinza" title="Nota cancelada: vale zero">cancelada</span>';
  if (Number(n.estorno) === 1) return '<span class="chip chip-vermelho" title="Lançar à mão nas saídas">estorno</span>';
  if (total === 0) return '<span class="chip chip-cinza">sem itens</span>';
  if (feitos >= total) return '<span class="chip chip-verde">✓ tratada</span>';
  if (notaVeioPronta(n)) return '<span class="chip chip-azul" title="Todos os itens que faltam vêm do que vocês ensinaram">veio pronta</span>';
  return `<span class="chip chip-amarelo">${feitos ? `faltam ${total - feitos}` : `${total} a conferir`}</span>`;
}

function progresso(n) {
  const total = n.total_itens ?? 0;
  const feitos = n.itens_revisados ?? 0;
  const pct = total ? Math.round((feitos / total) * 100) : 0;
  return `<div class="progresso" title="${feitos} de ${total} itens conferidos"><span style="width:${pct}%"></span></div>
    <span class="progresso-num">${feitos}/${total}</span>`;
}

function linhaNota(n) {
  const pronta = notaVeioPronta(n);
  const precisa = notaPrecisaDeVoce(n);
  const feitos = n.itens_revisados ?? 0;
  const valor = n.cancelada_em ? '0,00' : Number(n.estorno) === 1 ? `(${moeda(n.valor_total)})` : moeda(n.valor_total);
  return `<tr class="linha-nota${precisa ? '' : ' linha-calma'}" data-abrir="${esc(n.id)}" tabindex="0">
    <td class="col-seta">${pronta ? `<button type="button" class="seta" data-ver-itens="${esc(n.id)}" title="Ver os itens sem abrir a nota" aria-expanded="false">▸</button>` : ''}</td>
    <td class="col-data">${dataCurta(n.dh_emi)}</td>
    <td class="col-num mono">${esc(n.numero)}</td>
    <td class="col-forn"><span class="forn">${esc(n.emit_nome ?? n.emit_cnpj)}</span></td>
    <td class="col-prog">${progresso(n)}</td>
    <td class="col-valor num">${valor}</td>
    <td class="col-sit">${situacao(n)}</td>
    <td class="col-acao">${pronta && pode('notas.editar_cfop')
      ? `<button type="button" class="btn" data-conferir-pronta="${esc(n.id)}">Conferir</button>`
      : precisa ? `<button type="button" class="btn primario" data-abrir-btn="${esc(n.id)}">${feitos ? 'Continuar' : 'Tratar'}</button>`
      : `<button type="button" class="btn sutil" data-abrir-btn="${esc(n.id)}">Ver</button>`}</td>
  </tr>`;
}

function tabelaNotas(lista) {
  const cab = `<thead><tr><th class="col-seta"></th><th class="col-data">Emissão</th><th class="col-num">Nº</th><th class="col-forn">Fornecedor</th>
    <th class="col-prog">Conferidos</th><th class="col-valor num">Valor</th><th class="col-sit">Situação</th><th class="col-acao"></th></tr></thead>`;
  if (!estado.agrupar) return `<table class="tabela tabela-notas">${cab}<tbody>${lista.map(linhaNota).join('')}</tbody></table>`;
  // Por fornecedor: a decisão de CFOP costuma ser por fornecedor.
  const grupos = new Map();
  for (const n of lista) {
    const g = grupos.get(n.emit_cnpj) ?? { nome: n.emit_nome ?? n.emit_cnpj, cnpj: n.emit_cnpj, notas: [] };
    g.notas.push(n);
    grupos.set(n.emit_cnpj, g);
  }
  const ord = [...grupos.values()].sort((a, b) => b.notas.length - a.notas.length || a.nome.localeCompare(b.nome, 'pt-BR'));
  return `<table class="tabela tabela-notas">${cab}<tbody>${ord.map((g) => `
    <tr class="linha-grupo"><td colspan="8"><b>${esc(g.nome)}</b> <span class="suave">${esc(cnpjFormatado(g.cnpj))} · ${plural(g.notas.length, 'nota', 'notas')}</span></td></tr>
    ${g.notas.map(linhaNota).join('')}`).join('')}</tbody></table>`;
}

async function cliqueNaLista(ev) {
  const ir = ev.target.closest('[data-aba-ir]');
  if (ir) { estado.aba = ir.dataset.abaIr; return desenharLista(); }
  const seta = ev.target.closest('[data-ver-itens]');
  if (seta) return verItens(seta);
  const conf = ev.target.closest('[data-conferir-pronta]');
  if (conf) return conferirProntas([conf.dataset.conferirPronta]);
  const linha = ev.target.closest('[data-abrir]');
  if (linha && !ev.target.closest('.itens-mini')) location.hash = endereco({ t: 'nota', n: linha.dataset.abrir });
}

/* ------------------------------------------------------------ vieram prontas */

async function verItens(botao) {
  const tr = botao.closest('tr');
  const prox = tr.nextElementSibling;
  if (prox?.classList.contains('linha-itens')) { prox.remove(); botao.textContent = '▸'; botao.setAttribute('aria-expanded', 'false'); return; }
  botao.textContent = '▾';
  botao.setAttribute('aria-expanded', 'true');
  const sub = document.createElement('tr');
  sub.className = 'linha-itens';
  sub.innerHTML = '<td colspan="8"><div class="itens-mini">carregando os itens…</div></td>';
  tr.after(sub);
  try {
    const n = await api(`/api/notas/${botao.dataset.verItens}`);
    sub.querySelector('.itens-mini').innerHTML = `<table>${n.itens.map((i) => {
      const o = origemDoCfop(i.procedencia);
      return `<tr class="${i.revisado ? 'suave' : ''}">
        <td class="mono suave">${i.n_item}</td>
        <td>${esc(i.x_prod_novo || i.x_prod_original || '')}</td>
        <td class="mono">${esc(i.cfop_original ?? '')} → <b>${esc(i.cfop_novo ?? '—')}</b></td>
        <td>${o ? `<span class="chip chip-${o.cor}" title="${esc(o.dica)}">${esc(o.texto)}</span>` : ''}${i.revisado ? ' <span class="chip chip-verde">conferido</span>' : ''}</td>
        <td class="num">${moeda(i.valor_total)}</td></tr>`;
    }).join('')}</table>`;
  } catch (e) {
    sub.querySelector('.itens-mini').textContent = `Não consegui ler os itens: ${e.message}`;
  }
}

/** Confere só se, aberta, todos os itens que faltam vieram certos (mesma regra da tela de sempre). */
async function conferirProntas(ids) {
  if (ids.length > 1) {
    const ok = await confirmar({
      titulo: 'Conferir as notas que vieram prontas',
      ok: `Conferir ${plural(ids.length, 'nota', 'notas')}`,
      corpo: `<p>Todos os itens que faltam nestas ${ids.length} notas vêm do que vocês ensinaram para o próprio produto.</p>
        <p class="suave">Nota que, aberta, tiver algum aviso fica de fora, para você olhar.</p>`,
    });
    if (!ok) return;
  }
  let feitas = 0;
  const ficaram = [];
  try {
    await comEspera((async () => {
      for (const id of ids) {
        const n = await api(`/api/notas/${id}`);
        const faltam = n.itens.filter((i) => !i.revisado);
        const certos = itensQueVieramCertos(n);
        if (certos.length < faltam.length) { ficaram.push(n.nota); continue; }
        await enviar(`/api/notas/${id}/conferir`, { itens: certos.map((i) => i.id) });
        feitas += 1;
      }
    })());
  } catch (e) {
    return avisoErro(e, 'Não consegui conferir: ');
  }
  await atualizarDepoisDeGravar();
  desenharLista();
  if (ficaram.length) {
    await informar('Vieram prontas', `<p>${plural(feitas, 'nota conferida', 'notas conferidas')}.</p>
      <p>Ficaram para você olhar (algum item com aviso ou que não veio pronto):
      ${ficaram.map((n) => `<a href="${endereco({ t: 'nota', n: n.id })}">NF ${esc(n.numero)}</a>`).join(', ')}.</p>`);
  } else aviso(`${plural(feitas, 'nota conferida', 'notas conferidas')}`);
}

/* ------------------------------------------------------------ período */

function menuPeriodo(ev) {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hoje = new Date();
  const atalhos = {
    'este-mes': [iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), iso(hoje)],
    'mes-passado': [iso(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)), iso(new Date(hoje.getFullYear(), hoje.getMonth(), 0))],
    '7-dias': [iso(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - 6)), iso(hoje)],
    '30-dias': [iso(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - 29)), iso(hoje)],
  };
  const m = abrirMenu(ev.currentTarget, `
    <form class="periodo" id="form-periodo">
      <label>De <input type="date" id="p-de" value="${esc(estado.periodo.de)}"></label>
      <label>Até <input type="date" id="p-ate" value="${esc(estado.periodo.ate)}"></label>
      <div class="periodo-atalhos">
        <button type="button" class="btn sutil" data-atalho="este-mes">Este mês</button>
        <button type="button" class="btn sutil" data-atalho="mes-passado">Mês passado</button>
        <button type="button" class="btn sutil" data-atalho="7-dias">Últimos 7 dias</button>
        <button type="button" class="btn sutil" data-atalho="30-dias">Últimos 30 dias</button>
      </div>
      <p class="erro" id="p-erro" hidden></p>
      <div class="periodo-botoes">
        <button type="button" class="btn sutil" id="p-limpar">Qualquer data</button>
        <button type="submit" class="btn primario">Aplicar</button>
      </div>
    </form>`, () => {}, { largura: '320px' });
  const aplicar = (de, ate) => {
    if (de && ate && de > ate) { const e = $('#p-erro', m); e.textContent = 'A data "de" está depois da data "até".'; e.hidden = false; return; }
    estado.periodo = { de, ate };
    m.remove();
    desenharLista();
  };
  $('#form-periodo', m).addEventListener('submit', (e) => { e.preventDefault(); aplicar($('#p-de', m).value, $('#p-ate', m).value); });
  $('#p-limpar', m).addEventListener('click', () => aplicar('', ''));
  $$('[data-atalho]', m).forEach((b) => b.addEventListener('click', () => aplicar(...atalhos[b.dataset.atalho])));
}

/* ------------------------------------------------------------ procurar produto */

async function procurar(texto) {
  buscaAtual = texto.trim();
  if (!buscaAtual) { desenharLista(); return; }
  if (buscaAtual.length < 2) return aviso('Digite pelo menos 2 letras.', 'erro');
  $('#avisos-notas').innerHTML = '';
  $('#area-notas').innerHTML = '<div class="vazio">Procurando…</div>';
  let r;
  try {
    r = await comEspera(api(`/api/empresas/${estado.empresaId}/busca-itens?q=${encodeURIComponent(buscaAtual)}`));
  } catch (e) {
    $('#area-notas').innerHTML = `<div class="vazio">Não consegui procurar: ${esc(e.message)}</div>`;
    return;
  }
  const outras = (r.outras ?? []).map((o) => `<a href="${endereco({ t: 'notas', e: o.empresaId, m: 'todos' })}">${esc(o.razaoSocial)} (${o.itens})</a>`).join(' · ');
  $('#area-notas').innerHTML = `
    <div class="barra">
      <div><b>${plural(r.itens.length, 'item encontrado', 'itens encontrados')}</b> para “${esc(buscaAtual)}” em todas as notas desta empresa${r.itens.length >= r.limite ? ` (mostrando os ${r.limite} mais recentes)` : ''}.</div>
      <button type="button" class="btn sutil" id="limpar-busca">Voltar para a lista</button>
    </div>
    ${r.itens.length ? `<div class="tabela-caixa"><table class="tabela">
      <thead><tr><th>Emissão</th><th>Nº</th><th>Produto</th><th>Fornecedor</th><th>CFOP</th><th class="num">Valor</th><th>Situação</th></tr></thead>
      <tbody>${r.itens.map((i) => `<tr class="linha-nota" data-abrir-item="${esc(i.nota_id)}" data-item="${esc(i.item_id)}" tabindex="0">
        <td>${dataCurta(i.dh_emi)}</td><td class="mono">${esc(i.numero)}</td>
        <td>${esc(i.x_prod_novo || i.x_prod_original)}${i.x_prod_novo && i.x_prod_novo !== i.x_prod_original ? `<small class="suave bloco">na nota: ${esc(i.x_prod_original)}</small>` : ''}</td>
        <td class="forn">${esc(i.emit_nome ?? '')}</td>
        <td class="mono">${esc(i.cfop_original ?? '')} → <b>${esc(i.cfop_novo ?? '—')}</b></td>
        <td class="num">${moeda(i.valor_total)}</td>
        <td>${i.cancelada_em ? '<span class="chip chip-cinza">cancelada</span>' : i.revisado ? '<span class="chip chip-verde">conferido</span>' : '<span class="chip chip-amarelo">a conferir</span>'}</td>
      </tr>`).join('')}</tbody></table></div>`
      : `<div class="vazio">Nada encontrado nesta empresa.${outras ? ` Achei em: ${outras}.` : ''}</div>`}`;
  $('#limpar-busca').addEventListener('click', () => { $('#busca-produto').value = ''; procurar(''); });
  $('#area-notas').onclick = (ev) => {
    const tr = ev.target.closest('[data-abrir-item]');
    if (tr) location.hash = endereco({ t: 'nota', n: tr.dataset.abrirItem, i: tr.dataset.item });
  };
}

/* Enter numa linha da lista abre a nota (teclado). */
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const tr = ev.target.closest?.('[data-abrir], [data-abrir-item]');
  if (!tr || ev.target.closest('button, input')) return;
  tr.click();
});
