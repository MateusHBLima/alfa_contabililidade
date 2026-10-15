/* Alfa Fiscal v2 — entrada: topo (empresa e mês num lugar só), menu e troca de tela.
 *
 * A v2 muda a tela, não as regras: usa as mesmas rotas do servidor que a tela de
 * sempre. Cada tela mora no seu arquivo (notas.js, nota.js) para nenhum arquivo
 * virar o app.js de 5 mil linhas da versão anterior.
 */

import { api, MODO_TESTE } from './api.js';
import { $, $$, esc, nomeCompetencia, MESES, plural } from './util.js';
import { estado, empresaAtual, lerEndereco, endereco, linkTelaAntiga, lembrar, lembrado, pode } from './estado.js';
import { abrirMenu, comEspera } from './ui.js';
import { telaNotas } from './notas.js';
import { telaNota } from './nota.js';

/* ------------------------------------------------------------ início */

async function iniciar() {
  $('#faixa-teste').hidden = !MODO_TESTE;
  document.body.classList.toggle('em-teste', MODO_TESTE);
  estado.eu = await api('/api/eu');
  $('#usuario-sinal').textContent = (estado.eu.nome || estado.eu.email || '?').trim().slice(0, 1).toUpperCase();
  $('#btn-usuario').title = `${estado.eu.nome ?? ''} · ${estado.eu.email ?? ''}`;
  [estado.empresas] = await Promise.all([api('/api/empresas'), atualizarPendencias()]);
  if (estado.empresas.length === 0) {
    $('#tela').innerHTML = `<div class="vazio-grande"><b>Nenhuma empresa cadastrada.</b>
      <a class="btn primario" href="${linkTelaAntiga('vEmpresas')}">Cadastrar na tela de sempre</a></div>`;
    return;
  }
  window.addEventListener('hashchange', mostrar);
  await mostrar();
}

export async function atualizarPendencias() {
  try { estado.pendencias = (await api('/api/pendencias')).empresas; } catch { estado.pendencias = []; }
  desenharTopo();
}

/* ------------------------------------------------------------ empresa e mês */

async function abrirEmpresa(id) {
  estado.empresaId = id;
  lembrar('empresa', id);
  estado.nota = null;
  estado.competencias = await api(`/api/empresas/${id}/competencias`).catch(() => []);
}

/** O mês que vale ao abrir uma empresa: o do endereço, o último escolhido nela, ou o mais recente. */
function mesInicial(m) {
  const tem = (c) => c === '' || estado.competencias.some((x) => x.competencia === c || x.competencia.startsWith(c + '-'));
  if (m != null) { const c = m === 'todos' ? '' : m; if (tem(c)) return c; }
  const salvo = lembrado(`mes:${estado.empresaId}`);
  if (salvo != null && tem(salvo)) return salvo;
  return [...estado.competencias].sort((a, b) => b.competencia.localeCompare(a.competencia))[0]?.competencia ?? '';
}

export async function carregarNotas() {
  const q = estado.competencia ? `?competencia=${estado.competencia}` : '';
  estado.notas = await api(`/api/empresas/${estado.empresaId}/notas${q}`);
}

function desenharTopo() {
  const emp = empresaAtual();
  const pend = estado.pendencias.find((p) => p.empresaId === estado.empresaId);
  $('#empresa-nome').innerHTML = emp
    ? `${esc(emp.razao_social)}${pend ? ` <span class="contador" title="Notas a tratar nesta empresa">${pend.notas}</span>` : ''}`
    : '—';
  $('#mes-nome').textContent = nomeCompetencia(estado.competencia);
  const outras = estado.pendencias.filter((p) => p.empresaId !== estado.empresaId).length;
  $('#btn-empresa').classList.toggle('com-pendencia', outras > 0);
  $('#btn-empresa').title = outras ? `${plural(outras, 'outra empresa tem', 'outras empresas têm')} notas a tratar` : 'Trocar de empresa';
  for (const a of $$('[data-antiga]')) a.href = linkTelaAntiga(a.dataset.antiga);
}

$('#btn-empresa').addEventListener('click', (ev) => {
  const porId = new Map(estado.pendencias.map((p) => [p.empresaId, p]));
  const ordenadas = [...estado.empresas].sort((a, b) =>
    (porId.has(b.id) - porId.has(a.id)) || a.razao_social.localeCompare(b.razao_social, 'pt-BR'));
  const linha = (e) => {
    const p = porId.get(e.id);
    return `<button type="button" class="menu-op${e.id === estado.empresaId ? ' atual' : ''}" data-op="${esc(e.id)}" data-busca="${esc((e.razao_social + ' ' + e.cnpj).toUpperCase())}">
      <span class="menu-op-texto">${esc(e.razao_social)}<small>${esc(e.cnpj)}</small></span>
      ${p ? `<span class="contador" title="${plural(p.notas, 'nota', 'notas')} a tratar">${p.notas}</span>` : '<span class="ok-pequeno" title="Tudo tratado">✓</span>'}
    </button>`;
  };
  const m = abrirMenu(ev.currentTarget, `
    <input type="search" class="menu-busca" placeholder="Procurar empresa ou CNPJ" autocomplete="off">
    <div class="menu-lista">${ordenadas.map(linha).join('')}</div>`, async (id) => {
    if (id === estado.empresaId) return;
    location.hash = endereco({ t: 'notas', e: id, m: null });
  }, { largura: '420px' });
  m.querySelector('.menu-busca').addEventListener('input', (e) => {
    const q = e.target.value.trim().toUpperCase();
    for (const b of $$('.menu-op', m)) b.hidden = q && !b.dataset.busca.includes(q);
  });
});

$('#btn-mes').addEventListener('click', (ev) => {
  const anos = [...new Set(estado.competencias.map((c) => c.competencia.slice(0, 4)))].sort().reverse();
  const html = `<button type="button" class="menu-op${estado.competencia === '' ? ' atual' : ''}" data-op="todos">Todos os meses</button>` +
    anos.map((a) => `<div class="menu-grupo">${a}</div>` + estado.competencias
      .filter((c) => c.competencia.startsWith(a)).sort((x, y) => y.competencia.localeCompare(x.competencia))
      .map((c) => `<button type="button" class="menu-op${estado.competencia === c.competencia ? ' atual' : ''}" data-op="${c.competencia}">
        <span class="menu-op-texto">${MESES[Number(c.competencia.slice(5, 7)) - 1]}</span><span class="menu-num">${plural(c.notas, 'nota', 'notas')}</span></button>`).join('')).join('');
  abrirMenu(ev.currentTarget, `<div class="menu-lista">${html}</div>`, (c) => {
    location.hash = endereco({ t: 'notas', m: c });
  }, { largura: '260px' });
});

$('#btn-usuario').addEventListener('click', (ev) => {
  const admin = [['vEmpresas', 'Empresas', 'empresas.visualizar'], ['vRegrasIcms', 'Regras de ICMS', 'notas.visualizar'],
    ['vFornecedores', 'Fornecedores', 'notas.visualizar'], ['vRegras', 'Padrões aprendidos', 'regras.visualizar'],
    ['vUsuarios', 'Usuários', 'usuarios.visualizar'], ['vPapeis', 'Papéis', 'papeis.gerenciar'],
    ['vCertificados', 'Certificados', 'certificados.gerenciar'], ['vCaptura', 'Busca na SEF', 'captura.gerenciar']]
    .filter(([, , p]) => pode(p));
  abrirMenu(ev.currentTarget, `
    <div class="menu-cabeca"><b>${esc(estado.eu.nome ?? '')}</b><small>${esc(estado.eu.email ?? '')}</small></div>
    <div class="menu-grupo">Configurações <span class="seta-fora">na tela de sempre ↗</span></div>
    ${admin.map(([v, rot]) => `<a class="menu-op" href="${linkTelaAntiga(v)}">${esc(rot)}</a>`).join('')}
    <div class="menu-sep"></div>
    <a class="menu-op" href="${linkTelaAntiga('v1')}">Voltar para a tela de sempre</a>`, () => {}, { largura: '260px' });
});

/* ------------------------------------------------------------ troca de tela */

let mostrando = Promise.resolve();
function mostrar() {
  mostrando = mostrando.then(mostrarAgora, mostrarAgora);
  return mostrando;
}

async function mostrarAgora() {
  const end = lerEndereco();
  try {
    const empresaPedida = estado.empresas.some((x) => x.id === end.e) ? end.e : null;
    const id = empresaPedida ?? estado.empresaId ?? (estado.empresas.some((x) => x.id === lembrado('empresa')) ? lembrado('empresa')
      : (estado.pendencias[0]?.empresaId ?? estado.empresas[0].id));
    const trocouEmpresa = id !== estado.empresaId;
    if (trocouEmpresa) await comEspera(abrirEmpresa(id));
    const mes = mesInicial(trocouEmpresa ? end.m : (end.m ?? (estado.competencia || 'todos')));
    if (trocouEmpresa || mes !== estado.competencia || !estado.notas.length) {
      estado.competencia = mes;
      lembrar(`mes:${estado.empresaId}`, mes);
      if (trocouEmpresa || end.t !== 'nota') estado.aba = null;
      await comEspera(carregarNotas());
    }
    // Endereço sempre completo (empresa e mês), sem empilhar histórico.
    const certo = endereco();
    if (location.hash !== certo && end.t !== 'nota') history.replaceState(null, '', certo);
    desenharTopo();
    $$('#menu-principal [data-tela]').forEach((a) => a.classList.toggle('ativo', a.dataset.tela === (end.t === 'nota' ? 'notas' : end.t)));
    if (end.t === 'nota' && end.n) await telaNota(end.n, end.i);
    else await telaNotas();
  } catch (e) {
    if (e?.message === 'sessão expirada') return;
    $('#tela').innerHTML = `<div class="vazio-grande"><b>Não consegui abrir esta tela.</b><span>${esc(e?.message ?? e)}</span>
      <a class="btn" href="#t=notas">Voltar para as notas</a></div>`;
  }
}

/* Depois de gravar algo: notas, pendências e topo em dia. */
export async function atualizarDepoisDeGravar() {
  await Promise.all([carregarNotas(), atualizarPendencias()]);
}

iniciar().catch((e) => {
  if (e?.message !== 'sessão expirada') $('#tela').innerHTML = `<div class="vazio-grande"><b>Não consegui abrir o Alfa Fiscal.</b><span>${esc(e?.message ?? e)}</span></div>`;
});
