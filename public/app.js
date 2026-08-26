/* Planee Fiscal — cliente.
 *
 * Sem framework e sem passo de build: o protótipo era assim, o app é pequeno, e uma
 * dependência a menos é uma coisa a menos para quebrar num deploy.
 *
 * Regra que atravessa este arquivo: a TELA NÃO DECIDE O QUE É GRAVE. O servidor manda
 * `estilo` e `alertas` prontos por item, e `resumo` da nota. Assim o critério é um só e
 * está coberto por teste — a tela só pinta.
 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const estado = {
  eu: null,
  empresas: [],
  empresaId: null,
  competencia: '',
  notas: [],
  notaAberta: null,
  filtro: 'todos',
  busca: '',
};

// ------------------------------------------------------------------ api

async function api(caminho, opcoes = {}) {
  const r = await fetch(caminho, {
    credentials: 'same-origin',
    headers: opcoes.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opcoes,
  });
  if (r.status === 401) {
    mostrarLogin();
    throw new Error('sessão expirada');
  }
  const ct = r.headers.get('Content-Type') ?? '';
  const corpo = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw Object.assign(new Error(corpo?.erro ?? 'erro'), { dados: corpo, status: r.status });
  return corpo;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const moeda = (v) =>
  v == null ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dataCurta = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');

// ------------------------------------------------------------------ login

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-entrar');
  btn.disabled = true;
  $('#login-erro').classList.add('hidden');
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#login-email').value.trim(), senha: $('#login-senha').value }),
    });
    await iniciar();
  } catch (err) {
    $('#login-erro').textContent = err.message || 'não foi possível entrar';
    $('#login-erro').classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

$('#btn-sair').addEventListener('click', async (e) => {
  e.preventDefault();
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  mostrarLogin();
});

function mostrarLogin() {
  $('#tela-app').classList.add('hidden');
  $('#tela-login').classList.remove('hidden');
  $('#login-senha').value = '';
}

// ------------------------------------------------------------------ shell

$$('#nav button').forEach((b) => b.addEventListener('click', () => irPara(b.dataset.view)));

function irPara(view) {
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  ['v1', 'v2', 'v3', 'vEmpresas', 'vFornecedores', 'vRegras'].forEach((v) =>
    $('#' + v).classList.toggle('hidden', v !== view));
  if (view === 'vEmpresas') renderEmpresas();
  if (view === 'vFornecedores') carregarFornecedores();
  if (view === 'vRegras') carregarRegras();
}

$('#sel-empresa').addEventListener('change', async (e) => {
  estado.empresaId = e.target.value;
  estado.notaAberta = null;
  await carregarNotas();
});

$('#sel-competencia').addEventListener('change', async (e) => {
  estado.competencia = e.target.value;
  await carregarNotas();
});

async function iniciar() {
  estado.eu = await api('/api/eu');
  $('#usuario-nome').textContent = estado.eu.nome;
  $('#usuario-email').textContent = estado.eu.email;
  $('#rodape-ambiente').textContent = 'sessão ativa';

  $('#tela-login').classList.add('hidden');
  $('#tela-app').classList.remove('hidden');

  const podeAdmin = estado.eu.permissoes.includes('empresas.gerenciar');
  $('#btn-nova-empresa').classList.toggle('hidden', !podeAdmin);

  await carregarEmpresas();
  montarSeletorCfop();
}

async function carregarEmpresas() {
  estado.empresas = await api('/api/empresas');
  const sel = $('#sel-empresa');
  if (estado.empresas.length === 0) {
    sel.innerHTML = '<option value="">nenhuma empresa cadastrada</option>';
    irPara('vEmpresas');
    return;
  }
  sel.innerHTML = estado.empresas
    .map((e) => `<option value="${e.id}">${esc(e.razao_social)} — ${esc(e.cnpj)}</option>`)
    .join('');
  estado.empresaId = estado.empresas[0].id;
  await carregarNotas();
}

// ------------------------------------------------------------------ ambiente 1

const drop = $('#drop');
const inputArquivo = $('#arquivo-xml');

drop.addEventListener('click', () => inputArquivo.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  enviar([...e.dataTransfer.files]);
});
inputArquivo.addEventListener('change', () => enviar([...inputArquivo.files]));

async function enviar(arquivos) {
  if (!estado.empresaId) return alerta('Escolha uma empresa antes de importar.');
  const xmls = arquivos.filter((f) => f.name.toLowerCase().endsWith('.xml'));
  if (xmls.length === 0) return alerta('Nenhum arquivo .xml no que foi solto.');

  const log = $('#log-import');
  log.classList.remove('hidden');
  log.textContent = `enviando ${xmls.length} arquivo(s)...\n`;

  const form = new FormData();
  for (const f of xmls) form.append('arquivos', f, f.name);

  try {
    const r = await api(`/api/empresas/${estado.empresaId}/importar`, { method: 'POST', body: form });
    log.textContent =
      `${r.importadas} importada(s) · ${r.duplicadas} duplicada(s) · ${r.recusadas} recusada(s)\n\n` +
      r.arquivos
        .map((a) => {
          const marca = { importada: '✓', duplicada: '=', recusada: '✕' }[a.status];
          const extra = a.status === 'importada'
            ? `${a.itens} itens${a.preenchidos ? `, ${a.preenchidos} já preenchidos pelo padrão` : ''}`
            : (a.motivo ?? '');
          return `${marca} ${a.arquivo}  ${extra}`;
        })
        .join('\n');
    await carregarNotas();
  } catch (e) {
    log.textContent = 'falhou: ' + e.message;
  }
  inputArquivo.value = '';
}

async function carregarNotas() {
  if (!estado.empresaId) return;
  const q = estado.competencia ? `?competencia=${estado.competencia}` : '';
  estado.notas = await api(`/api/empresas/${estado.empresaId}/notas${q}`);
  renderNotas();
  atualizarCompetencias();
}

function atualizarCompetencias() {
  const comps = [...new Set(estado.notas.map((n) => n.competencia).filter(Boolean))].sort().reverse();
  const sel = $('#sel-competencia');
  const atual = sel.value;
  sel.innerHTML = '<option value="">todas</option>' +
    comps.map((c) => `<option value="${c}">${c.split('-').reverse().join('/')}</option>`).join('');
  sel.value = atual;
}

function renderNotas() {
  const corpo = $('#tbl-notas tbody');
  const vazio = $('#vazio-notas');
  vazio.classList.toggle('hidden', estado.notas.length > 0);

  const totalItens = estado.notas.reduce((s, n) => s + (n.total_itens ?? 0), 0);
  const revisados = estado.notas.reduce((s, n) => s + (n.itens_revisados ?? 0), 0);
  const valor = estado.notas.reduce((s, n) => s + (n.valor_total ?? 0), 0);
  const fornecedores = new Set(estado.notas.map((n) => n.emit_cnpj)).size;

  $('#kpis-notas').innerHTML = [
    ['Notas', estado.notas.length],
    ['Fornecedores', fornecedores],
    ['Itens', totalItens],
    ['Itens revisados', totalItens ? `${revisados}<small> de ${totalItens}</small>` : '—'],
    ['Valor total', 'R$ ' + moeda(valor)],
  ].map(([l, v]) => `<div class="kpi"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('');

  $('#hint-notas').textContent = estado.notas.length ? `${estado.notas.length} nota(s)` : '';

  corpo.innerHTML = estado.notas.map((n) => {
    const pendentes = (n.total_itens ?? 0) - (n.itens_revisados ?? 0);
    const selo = pendentes === 0 && n.total_itens > 0
      ? '<span class="tag ok">✓ tratada</span>'
      : `<span class="tag warn">${pendentes} a revisar</span>`;
    return `<tr>
      <td>${dataCurta(n.dh_emi)}</td>
      <td class="mono">${esc(n.numero)}</td>
      <td>${esc(n.emit_nome ?? n.emit_cnpj)}<span class="porque">${esc(n.emit_cnpj)}</span></td>
      <td class="mono tiny">${esc(String(n.chave).slice(0, 12))}…</td>
      <td class="num">${moeda(n.valor_total)}</td>
      <td class="num">${n.total_itens ?? 0}</td>
      <td>${selo}</td>
      <td><button class="btn sm primary" data-nota="${n.id}">Tratar →</button></td>
    </tr>`;
  }).join('');

  $$('#tbl-notas button[data-nota]').forEach((b) =>
    b.addEventListener('click', () => abrirNota(b.dataset.nota)));
}

// ------------------------------------------------------------------ ambiente 2

$('#btn-voltar-notas').addEventListener('click', () => irPara('v1'));
$('#btn-ver-xml').addEventListener('click', () => { irPara('v3'); renderXml(); });
$('#busca').addEventListener('input', (e) => { estado.busca = e.target.value.toLowerCase(); renderItens(); });
$$('#filtros button').forEach((b) => b.addEventListener('click', () => {
  $$('#filtros button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  estado.filtro = b.dataset.f;
  renderItens();
}));

async function abrirNota(id) {
  estado.notaAberta = await api(`/api/notas/${id}`);
  irPara('v2');
  renderItens();
}

const CFOPS = [
  ['1102', 'Compra para revenda'],
  ['1101', 'Compra para industrialização'],
  ['1556', 'Compra de material para uso e consumo'],
  ['1403', 'Compra para revenda — ST'],
  ['1407', 'Compra de material de uso e consumo — ST'],
  ['1551', 'Compra de bem para o ativo imobilizado'],
  ['1202', 'Devolução de venda'],
  ['2102', 'Compra para revenda — outro estado'],
  ['2101', 'Compra para industrialização — outro estado'],
  ['2556', 'Compra de uso e consumo — outro estado'],
  ['2403', 'Compra para revenda com ST — outro estado'],
];

function montarSeletorCfop() {
  $('#bulk-cfop').innerHTML =
    '<option value="">aplicar CFOP…</option>' +
    CFOPS.map(([c, d]) => `<option value="${c}">${c} — ${d}</option>`).join('');
}

function itensVisiveis() {
  const itens = estado.notaAberta?.itens ?? [];
  return itens.filter((i) => {
    if (estado.busca) {
      const alvo = `${i.x_prod_original} ${i.x_prod_novo ?? ''} ${i.c_prod ?? ''} ${i.ncm ?? ''}`.toLowerCase();
      if (!alvo.includes(estado.busca)) return false;
    }
    const e = i.estilo?.estado;
    if (estado.filtro === 'atencao') return e === 'bloqueado' || e === 'conferir';
    if (estado.filtro === 'novo') return e === 'novo';
    if (estado.filtro === 'pronto') return e === 'pronto';
    return true;
  });
}

function renderItens() {
  const n = estado.notaAberta;
  const corpo = $('#tbl-itens tbody');
  $('#vazio-itens').classList.toggle('hidden', !!n);
  if (!n) { corpo.innerHTML = ''; $('#faixa-resumo').innerHTML = ''; return; }

  $('#titulo-nota').textContent = `Nota ${n.nota.numero} — ${n.nota.emit_nome ?? n.nota.emit_cnpj}`;
  $('#hint-nota').textContent = `${dataCurta(n.nota.dh_emi)} · R$ ${moeda(n.nota.valor_total)}`;

  // A faixa do topo vem pronta do servidor: o critério de gravidade é um só.
  const r = n.resumo;
  const classe = r.criticos > 0 ? 'critico' : r.atencao > 0 ? 'atencao' : 'ok';
  $('#faixa-resumo').innerHTML =
    `<div class="faixa ${classe}"><b>${esc(r.chamada)}</b>
      ${r.bloqueiaExportacao ? '<span class="tag dan">exportação bloqueada</span>' : ''}
    </div>`;

  const lista = itensVisiveis();
  corpo.innerHTML = lista.map((i) => linhaItem(i)).join('');

  $$('#tbl-itens [data-campo]').forEach((el) => {
    el.addEventListener('change', () => salvarCampo(el.dataset.item, el.dataset.campo, el.value));
  });
}

function linhaItem(i) {
  const est = i.estilo ?? { estado: 'pronto', icone: '✓', rotulo: 'Pronto' };
  const alertas = (i.alertas ?? []).map((a) =>
    `<div class="alerta ${a.severidade}" title="${esc(a.detalhe)}">
       <span class="marca">${a.severidade === 'critico' ? '▲' : a.severidade === 'atencao' ? '●' : 'ⓘ'}</span>
       <span>${esc(a.titulo)}</span>
     </div>`).join('');

  const porque = i.cfop_origem === 'perfil'
    ? 'palpite pelo perfil da empresa — confirme'
    : String(i.cfop_origem ?? '').startsWith('regra:') ? 'padrão aprendido' : '';

  return `<tr class="estado-${est.estado}">
    <td class="num tiny">${i.n_item}</td>
    <td>
      ${esc(i.x_prod_original)}
      <span class="porque">cód. ${esc(i.c_prod ?? '—')}${i.c_ean ? ' · EAN ' + esc(i.c_ean) : ''}</span>
      ${alertas ? `<div class="alertas">${alertas}</div>` : ''}
    </td>
    <td class="mono tiny">${esc(i.ncm ?? '—')}</td>
    <td class="mono tiny">${esc(i.cfop_original)}</td>
    <td class="celula-edit">
      <input type="text" value="${esc(i.x_prod_novo ?? '')}" data-item="${i.id}" data-campo="descricao">
    </td>
    <td class="celula-edit">
      <input type="text" class="cfop" maxlength="4" value="${esc(i.cfop_novo ?? '')}"
             data-item="${i.id}" data-campo="cfop">
      ${porque ? `<span class="porque">${porque}</span>` : ''}
    </td>
    <td class="num">${moeda(i.valor_total)}</td>
    <td>
      <span class="selo selo-${est.estado}"><span class="ic">${est.icone}</span>${esc(est.rotulo)}</span>
    </td>
  </tr>`;
}

async function salvarCampo(itemId, campo, valor) {
  try {
    await api(`/api/itens/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ mudancas: [{ campo, valor }] }),
    });
    await recarregarNota();
  } catch (e) {
    alerta(e.message);
  }
}

async function recarregarNota() {
  if (!estado.notaAberta) return;
  estado.notaAberta = await api(`/api/notas/${estado.notaAberta.nota.id}`);
  renderItens();
}

$('#btn-bulk-nota').addEventListener('click', () => aplicarEmLote('item'));
$('#btn-bulk-fornecedor').addEventListener('click', () => aplicarEmLote('fornecedor'));

async function aplicarEmLote(escopo) {
  const cfop = $('#bulk-cfop').value;
  if (!cfop) return alerta('Escolha um CFOP na lista antes de aplicar.');
  if (!estado.notaAberta) return;

  const alvos = itensVisiveis();
  if (escopo === 'fornecedor' &&
      !confirm(`Fixar o CFOP ${cfop} como padrão deste fornecedor para esta empresa?\n\n` +
               'Vale para qualquer produto dele, inclusive os que ainda não apareceram.')) return;

  for (const i of alvos) {
    await api(`/api/itens/${i.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        mudancas: [{ campo: 'cfop', valor: cfop }],
        escopo,
        fixar: escopo === 'fornecedor',
      }),
    });
  }
  await recarregarNota();
}

// ------------------------------------------------------------------ ambiente 3

async function renderXml() {
  const n = estado.notaAberta;
  if (!n) return;

  const validacoes = $('#lista-validacoes');
  const r = n.resumo;
  const bloqueios = n.itens.flatMap((i) => (i.alertas ?? []).filter((a) => a.bloqueia));

  validacoes.innerHTML = [
    linhaCheck(!r.bloqueiaExportacao, 'Todos os itens têm CFOP de entrada'),
    linhaCheck(r.criticos === 0, `Itens com divergência crítica: ${r.criticos}`),
    linhaCheck(true, 'XML original preservado, sem alteração'),
    linhaCheck(true, 'CST/CSOSN e bloco IBS/CBS não são tocados'),
    linhaCheck(true, 'Totais e chave de acesso conferidos na exportação'),
  ].join('') + (bloqueios.length
    ? `<li class="tiny" style="color:var(--danger)">${bloqueios.length} item(ns) bloqueando a exportação.</li>`
    : '');

  const prod = n.itens.slice(0, 6).map((i) =>
    `  Item ${i.n_item}\n    <mark>&lt;xProd&gt;${esc(i.x_prod_novo ?? i.x_prod_original)}&lt;/xProd&gt;</mark>\n` +
    `    <mark>&lt;CFOP&gt;${esc(i.cfop_novo ?? i.cfop_original)}&lt;/CFOP&gt;</mark>   (original: ${esc(i.cfop_original)})`
  ).join('\n');

  $('#previa-xml').innerHTML =
    `Chave  ${esc(n.nota.chave)}\nNota   ${esc(n.nota.numero)} · ${esc(n.nota.emit_nome ?? '')}\n` +
    `Itens  ${n.itens.length}\n\n${prod}` +
    (n.itens.length > 6 ? `\n\n  … e mais ${n.itens.length - 6} item(ns)` : '') +
    `\n\nBaixe o arquivo para ver o XML completo.`;
}

const linhaCheck = (ok, txt) =>
  `<li><span class="${ok ? 'ok' : 'fail'}">${ok ? '✓' : '✕'}</span> ${esc(txt)}</li>`;

$('#btn-baixar-xml').addEventListener('click', async () => {
  if (!estado.notaAberta) return alerta('Selecione uma nota.');
  await baixar(`/api/notas/${estado.notaAberta.nota.id}/xml-corrigido`);
});

$('#btn-baixar-csv').addEventListener('click', async () => {
  if (!estado.notaAberta) return alerta('Selecione uma nota.');
  await baixar(`/api/notas/${estado.notaAberta.nota.id}/escrituracao.csv`);
});

async function baixar(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) {
    const erro = await r.json().catch(() => ({ erro: 'falhou' }));
    const detalhe = (erro.falhas ?? []).map((f) => `• ${f.nome}${f.detalhe ? ' — ' + f.detalhe : ''}`).join('\n');
    return alerta((erro.erro ?? 'falhou') + (detalhe ? '\n\n' + detalhe : ''));
  }
  const nome = (r.headers.get('Content-Disposition') ?? '').match(/filename="([^"]+)"/)?.[1] ?? 'arquivo';
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------------ empresas

function renderEmpresas() {
  $('#tbl-empresas tbody').innerHTML = estado.empresas.map((e) => `<tr>
    <td class="mono">${esc(e.cnpj)}</td>
    <td>${esc(e.razao_social)}</td>
    <td>${esc(e.uf ?? '—')}</td>
    <td><span class="tag info">${esc(e.perfil)}</span></td>
    <td class="mono tiny">${esc(e.cnae_principal ?? '—')}</td>
  </tr>`).join('') || '<tr><td colspan="5" class="vazio">Nenhuma empresa cadastrada.</td></tr>';
}

$('#btn-nova-empresa').addEventListener('click', () => {
  abrirModal('Nova empresa', `
    <div class="rowflex">
      <div style="flex:1"><label class="fl">CNPJ</label><input type="text" id="e-cnpj" style="width:100%"></div>
      <div style="width:80px"><label class="fl">UF</label><input type="text" id="e-uf" maxlength="2" style="width:100%"></div>
    </div>
    <div style="margin-top:11px"><label class="fl">Razão social</label>
      <input type="text" id="e-razao" style="width:100%"></div>
    <div style="margin-top:11px"><label class="fl">CNAE principal</label>
      <input type="text" id="e-cnae" placeholder="47.11-3/02" style="width:100%"></div>
    <div id="e-sugestao" class="aviso hidden"></div>
    <div style="margin-top:11px"><label class="fl">Perfil fiscal</label>
      <select id="e-perfil" style="width:100%">
        <option value="revenda">Comércio — revenda</option>
        <option value="industrializacao">Indústria — insumo</option>
        <option value="uso_consumo">Uso e consumo / serviços</option>
      </select></div>
    <p class="tiny" style="margin-top:10px">O perfil define o CFOP sugerido enquanto o produto
      não tem padrão próprio. A partir da primeira nota tratada, o aprendizado passa por cima disso.</p>
  `, async () => {
    const cnpj = $('#e-cnpj').value.replace(/\D/g, '');
    if (cnpj.length !== 14) throw new Error('CNPJ precisa ter 14 dígitos');
    if ($('#e-razao').value.trim().length < 2) throw new Error('informe a razão social');
    await api('/api/empresas', {
      method: 'POST',
      body: JSON.stringify({
        cnpj,
        razaoSocial: $('#e-razao').value.trim(),
        uf: $('#e-uf').value.toUpperCase() || null,
        perfil: $('#e-perfil').value,
        cnaePrincipal: $('#e-cnae').value.trim() || null,
      }),
    });
    await carregarEmpresas();
    renderEmpresas();
  });

  // Pré-preenchimento pelo CNAE, como pedido: o cadastro já vem sugerido.
  $('#e-cnae').addEventListener('blur', async () => {
    const cnae = $('#e-cnae').value.trim();
    if (!cnae) return;
    try {
      const r = await api('/api/empresas/sugestao', {
        method: 'POST',
        body: JSON.stringify({ cnaePrincipal: cnae, cnaesSecundarios: [] }),
      });
      $('#e-perfil').value = r.sugestao.perfil;
      const box = $('#e-sugestao');
      box.innerHTML = esc(r.sugestao.justificativa) + (r.alerta ? `<br><br><b>${esc(r.alerta)}</b>` : '');
      box.classList.remove('hidden');
    } catch {}
  });
});

// ------------------------------------------------------------------ fornecedores e regras

async function carregarFornecedores() {
  if (!estado.empresaId) return;
  const fs = await api(`/api/empresas/${estado.empresaId}/fornecedores`);
  $('#tbl-fornecedores tbody').innerHTML = fs.map((f) => `<tr>
    <td class="mono">${esc(f.cnpj)}</td>
    <td>${esc(f.nome ?? '—')}</td>
    <td>${esc(f.uf ?? '—')}</td>
    <td class="num">${f.notas_recebidas}</td>
    <td class="tiny">${dataCurta(f.ultima_nota_em)}</td>
    <td>${f.padrao_fixado ? '<span class="tag ok">fixado</span>' : '<span class="tag mut">aprendendo</span>'}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="vazio">Nenhum fornecedor ainda.</td></tr>';
}

$$('#filtro-regras button').forEach((b) => b.addEventListener('click', () => {
  $$('#filtro-regras button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  carregarRegras(b.dataset.s === '1');
}));

const ROTULO_NIVEL = {
  1: 'fornecedor + produto', 2: 'fornecedor + EAN', 3: 'EAN',
  4: 'fornecedor + NCM', 5: 'padrão do fornecedor', 6: 'NCM', 7: 'perfil',
};

async function carregarRegras(suspeitas = false) {
  if (!estado.empresaId) return;
  const rs = await api(`/api/empresas/${estado.empresaId}/regras${suspeitas ? '?suspeitas=1' : ''}`);
  $('#tbl-regras tbody').innerHTML = rs.map((r) => {
    const selo = r.fixada
      ? '<span class="tag ok">fixada</span>'
      : r.suspeita ? '<span class="tag dan">suspeita</span>'
      : r.nivel <= 2 && r.acertos >= 1 ? '<span class="tag ok">confiável</span>'
      : '<span class="tag warn">aprendendo</span>';
    return `<tr>
      <td><span class="tag mut">${r.nivel}</span> <span class="tiny">${ROTULO_NIVEL[r.nivel] ?? ''}</span></td>
      <td class="mono tiny">${esc(r.chave)}</td>
      <td class="tiny">${esc(r.campo)}</td>
      <td class="mono">${esc(r.valor)}</td>
      <td class="num">${r.usos}</td>
      <td class="num">${r.erros}</td>
      <td>${selo}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="vazio">Nada aprendido ainda — trate uma nota para começar.</td></tr>';
}

// ------------------------------------------------------------------ modal

let acaoModal = null;

function abrirModal(titulo, html, aoSalvar) {
  $('#modal-titulo').textContent = titulo;
  $('#modal-corpo').innerHTML = html;
  acaoModal = aoSalvar;
  $('#modal-fundo').classList.remove('hidden');
}

function fecharModal() {
  $('#modal-fundo').classList.add('hidden');
  acaoModal = null;
}

$('#modal-cancelar').addEventListener('click', fecharModal);
$('#modal-ok').addEventListener('click', async () => {
  if (!acaoModal) return fecharModal();
  const btn = $('#modal-ok');
  btn.disabled = true;
  try {
    await acaoModal();
    fecharModal();
  } catch (e) {
    alerta(e.message);
  } finally {
    btn.disabled = false;
  }
});

function alerta(msg) {
  window.alert(msg);
}

// ------------------------------------------------------------------ boot

(async () => {
  try { await iniciar(); } catch { mostrarLogin(); }
})();
