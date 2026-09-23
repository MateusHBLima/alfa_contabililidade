/* Alfa Fiscal — cliente.
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
  filtroNotas: 'todas',
  importacoes: [],
  importacaoId: '',
  agruparFornecedor: false,
  fornecedoresFechados: new Set(),
  eu: null,
  empresas: [],
  empresaId: null,
  demo: null,   // par de teste do modo local, quando /api/local responde
  desafioMfa: null,
  competencia: '',
  competencias: [],
  notas: [],
  notaAberta: null,
  filtro: 'todos',
  busca: '',
};

// ------------------------------------------------------------------ api

/**
 * O que a pessoa logada pode. Vive aqui no escopo do módulo, e não dentro de uma
 * função, porque as telas de lista também precisam dela — quando isto era um
 * `const` local, `renderNotas` e `renderEmpresas` quebravam com
 * "pode is not defined" e a tabela aparecia vazia, sem erro visível.
 *
 * Esconder botão é conveniência, não segurança: cada rota confere a permissão
 * por conta própria no servidor.
 */
function pode(p) {
  return !!estado.eu?.permissoes?.includes(p);
}

async function api(caminho, opcoes = {}) {
  const r = await fetch(caminho, {
    credentials: 'same-origin',
    headers: opcoes.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opcoes,
  });
  // O 401 do PRÓPRIO login significa "e-mail ou senha inválidos" — não sessão
  // vencida. A mensagem errada manda o usuário procurar o problema no lugar
  // errado. Foi bug de verdade: a primeira tentativa de entrar em produção
  // mostrou "sessão expirada" para quem nunca tinha tido sessão nenhuma.
  // As duas etapas do login ficam de fora: 401 nelas quer dizer "credencial
  // errada", não "sessão vencida". Tratar igual mandava o usuário de volta para
  // a primeira tela, com os campos limpos, ao errar um dígito do código — e a
  // mensagem "sessão expirada" o fazia procurar o problema no lugar errado.
  const ROTAS_DE_ENTRADA = ['/api/login', '/api/login/mfa'];
  if (r.status === 401 && !ROTAS_DE_ENTRADA.includes(caminho)) {
    mostrarLogin();
    throw new Error('sessão expirada');
  }
  const ct = r.headers.get('Content-Type') ?? '';
  const corpo = ct.includes('json') ? await r.json() : await r.text();
  // Senha redefinida por um administrador: o servidor recusa tudo até a troca.
  // A tela abre o formulário em vez de mostrar um 403 seco em cada clique.
  if (r.status === 403 && corpo && corpo.deveTrocarSenha) {
    if (!$('#modal-fundo').classList.contains('hidden')) { /* já está aberto */ }
    else abrirTrocaDeSenha(true);
  }
  if (!r.ok) throw Object.assign(new Error(corpo?.erro ?? 'erro'), { dados: corpo, status: r.status });
  return corpo;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const moeda = (v) =>
  v == null ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dataCurta = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');
/** Data e hora locais, para distinguir duas importacoes do mesmo dia. */
const dataHora = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return dataCurta(iso);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
};

// ------------------------------------------------------------------ login

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-entrar');
  btn.disabled = true;
  $('#login-erro').classList.add('hidden');
  try {
    const r = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#login-email').value.trim(), senha: $('#login-senha').value }),
    });

    // Senha certa, sessão ainda não. Pedimos o segundo fator sem sair da tela.
    if (r && r.mfaRequerido) {
      estado.desafioMfa = r.desafio;
      $('#passo-mfa').classList.remove('hidden');
      $('#login-email').disabled = true;
      $('#login-senha').disabled = true;
      $('#btn-entrar').classList.add('hidden');
      $('#mfa-codigo').focus();
      return;
    }

    await iniciar();
    if (r && r.deveTrocarSenha) abrirTrocaDeSenha(true);
  } catch (err) {
    $('#login-erro').textContent = err.message || 'não foi possível entrar';
    $('#login-erro').classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

/* Credenciais de teste na tela de login.
   So aparece se /api/local responder — o que exige LOGIN_DEMO no .dev.vars, que
   nao sobe em deploy nenhum. Em producao o fetch da 404 e nada acontece. */
(async function cartaoLocal() {
  try {
    const r = await fetch('/api/local');
    if (!r.ok) return;
    const { email, senha } = await r.json();
    if (!email || !senha) return;

    $('#demo-email').textContent = email;
    $('#demo-senha').textContent = senha;
    $('#cartao-local').classList.remove('hidden');

    estado.demo = { email, senha };
    $('#btn-preencher').addEventListener('click', preencherDemo);
    preencherDemo();   // ja chega preenchido: um Enter e voce esta dentro

    for (const b of $$('#cartao-local .copiar')) {
      b.addEventListener('click', async () => {
        const texto = $('#' + b.dataset.alvo).textContent;
        try { await navigator.clipboard.writeText(texto); } catch {
          // clipboard bloqueado (http sem localhost, permissao negada): seleciona
          // o texto para o Ctrl+C funcionar. Botao que nao faz nada e pior que
          // botao que faz metade.
          const faixa = document.createRange();
          faixa.selectNodeContents($('#' + b.dataset.alvo));
          const sel = getSelection(); sel.removeAllRanges(); sel.addRange(faixa);
        }
        const antes = b.textContent;
        b.textContent = 'copiado';
        setTimeout(() => { b.textContent = antes; }, 1200);
      });
    }
  } catch { /* sem rota, sem cartao */ }
})();

/* Trocar senha dentro do app.
   Faltava, e a falta apareceu do pior jeito: a senha do primeiro admin em
   producao foi digitada as cegas, sem confirmacao, e a unica saida era um
   script na maquina de quem publicou. */
function abrirTrocaDeSenha(forcado = false) {
  abrirModal(forcado ? 'Defina uma senha nova' : 'Trocar senha', `
    ${forcado ? '<p class="page-desc">Sua senha precisa ser trocada antes de continuar.</p>' : ''}
    <div class="campo">
      <label class="fl" for="ts-atual">Senha atual</label>
      <input type="password" id="ts-atual" autocomplete="current-password">
    </div>
    <div class="campo">
      <label class="fl" for="ts-nova">Senha nova</label>
      <input type="password" id="ts-nova" autocomplete="new-password">
    </div>
    <div class="campo">
      <label class="fl" for="ts-confirma">Repita a senha nova</label>
      <input type="password" id="ts-confirma" autocomplete="new-password">
    </div>
    <p class="page-desc">Pelo menos 12 caracteres. Uma frase longa vale mais que
      símbolo estranho — e você não vai anotá-la num papel.</p>
    <p class="page-desc"><b>Todas as sessões abertas serão encerradas</b>, aqui e em
      qualquer outro computador. Menos esta.</p>
  `, async () => {
    const atual = $('#ts-atual').value;
    const nova = $('#ts-nova').value;
    // Confere aqui tambem: erro de digitacao nao precisa de ida ao servidor,
    // e foi exatamente o que fez a senha do primeiro admin sair errada.
    if (nova !== $('#ts-confirma').value) throw new Error('as duas senhas novas não batem');
    if (!atual || !nova) throw new Error('preencha os três campos');
    await api('/api/trocar-senha', {
      method: 'POST',
      body: JSON.stringify({ senhaAtual: atual, senhaNova: nova }),
    });
    alerta('Senha trocada. As outras sessões foram encerradas.');
  });
}

$('#btn-trocar-senha').addEventListener('click', (e) => {
  e.preventDefault();
  abrirTrocaDeSenha();
});

/* ------------------------------------------------------------------ cadastro */

/** Três formulários no mesmo cartão: entrar, pedir acesso, esquecer a senha. */
function mostrarFormulario(qual) {
  for (const [id, nome] of [['#form-login', 'login'], ['#form-cadastro', 'cadastro'], ['#form-esqueci', 'esqueci']]) {
    $(id).classList.toggle('hidden', nome !== qual);
  }
  for (const p of ['cadastro', 'esqueci']) {
    $(`#${p}-erro`).classList.add('hidden');
    $(`#${p}-ok`).classList.add('hidden');
    $(`#${p}-campos`).classList.remove('hidden');
  }
}
const mostrarCadastro = (mostrar) => mostrarFormulario(mostrar ? 'cadastro' : 'login');

$('#link-esqueci').addEventListener('click', (e) => { e.preventDefault(); mostrarFormulario('esqueci'); });
$('#btn-voltar-login3').addEventListener('click', (e) => { e.preventDefault(); mostrarFormulario('login'); });
$('#btn-voltar-login4').addEventListener('click', () => mostrarFormulario('login'));

$('#btn-esqueci').addEventListener('click', async (e) => {
  e.preventDefault();
  const btn = $('#btn-esqueci');
  btn.disabled = true;
  $('#esqueci-erro').classList.add('hidden');
  try {
    const r = await api('/api/esqueci', {
      method: 'POST', body: JSON.stringify({ email: $('#esq-email').value.trim() }),
    });
    $('#esqueci-campos').classList.add('hidden');
    $('#esqueci-msg').textContent = r.mensagem;
    $('#esqueci-ok').classList.remove('hidden');
  } catch (err) {
    $('#esqueci-erro').textContent = err.message || 'não foi possível registrar o pedido';
    $('#esqueci-erro').classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

$('#link-criar-conta').addEventListener('click', (e) => { e.preventDefault(); mostrarCadastro(true); });

// Link de convite abre direto no cadastro, com o código já preenchido: quem
// recebe o link não precisa entender o que fazer com um código solto.
(() => {
  const codigo = new URLSearchParams(location.search).get('convite');
  if (!codigo) return;
  $('#cad-convite').value = codigo;
  mostrarFormulario('cadastro');
})();
$('#btn-voltar-login').addEventListener('click', (e) => { e.preventDefault(); mostrarCadastro(false); });
$('#btn-voltar-login2').addEventListener('click', () => mostrarCadastro(false));

$('#btn-cadastrar').addEventListener('click', async (e) => {
  e.preventDefault();
  const btn = $('#btn-cadastrar');
  const erro = (m) => {
    $('#cadastro-erro').textContent = m;
    $('#cadastro-erro').classList.remove('hidden');
  };
  $('#cadastro-erro').classList.add('hidden');

  const senha = $('#cad-senha').value;
  // Confere aqui as duas senhas: é erro de digitação, não precisa de servidor —
  // e no cadastro ele custa caro, porque a pessoa fica com uma conta cuja senha
  // não é a que ela pensa, esperando aprovação para descobrir isso.
  if (senha !== $('#cad-senha2').value) return erro('as duas senhas não são iguais');
  if (!$('#cad-nome').value.trim()) return erro('informe seu nome');

  btn.disabled = true;
  try {
    const r = await api('/api/cadastrar', {
      method: 'POST',
      body: JSON.stringify({
        nome: $('#cad-nome').value.trim(),
        email: $('#cad-email').value.trim(),
        senha,
        convite: $('#cad-convite').value.trim() || undefined,
      }),
    });
    $('#cadastro-campos').classList.add('hidden');
    $('#cadastro-msg').textContent = r.mensagem;
    $('#cadastro-ok').classList.remove('hidden');
  } catch (err) {
    erro(err.message || 'não foi possível registrar o pedido');
  } finally {
    btn.disabled = false;
  }
});

$('#btn-mfa').addEventListener('click', async () => {
  const btn = $('#btn-mfa');
  btn.disabled = true;
  $('#login-erro').classList.add('hidden');
  try {
    const r = await api('/api/login/mfa', {
      method: 'POST',
      body: JSON.stringify({ desafio: estado.desafioMfa, codigo: $('#mfa-codigo').value }),
    });
    await iniciar();
    if (r && r.deveTrocarSenha) abrirTrocaDeSenha(true);
  } catch (err) {
    $('#login-erro').textContent = err.message || 'código não confere';
    $('#login-erro').classList.remove('hidden');
    // Desafio vencido ou gasto: a mensagem manda começar de novo, e sem isto não
    // existia controle nenhum para isso — os campos ficavam travados e o botão
    // Entrar escondido. Só F5 resolvia.
    if (err && err.dados && err.dados.expirado) mostrarLogin();
    else $('#mfa-codigo').select();
  } finally {
    btn.disabled = false;
  }
});

// Enter no campo do código confirma, em vez de reenviar a senha.
$('#mfa-codigo').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#btn-mfa').click(); }
});

/* ---------------------------------------------------------------- segurança */

async function abrirSeguranca() {
  const est = await api('/api/mfa');

  if (est.ativo) {
    abrirModal('Segundo fator', `
      <p class="page-desc"><b>Está ligado.</b> Confirmado em
        ${est.confirmadoEm ? new Date(est.confirmadoEm).toLocaleDateString('pt-BR') : '—'}.
        Códigos de recuperação ainda válidos: <b>${est.codigosRestantes}</b>.</p>
      <p class="page-desc">Para desligar, confirme sua senha e um código do aplicativo.
        As duas coisas, porque desligar a proteção não pode ser mais fácil do que usá-la.</p>
      <div class="campo">
        <label class="fl" for="sg-senha">Sua senha</label>
        <input type="password" id="sg-senha" autocomplete="current-password">
      </div>
      <div class="campo">
        <label class="fl" for="sg-codigo">Código do aplicativo</label>
        <input type="text" id="sg-codigo" inputmode="numeric" maxlength="6" placeholder="000000">
      </div>
    `, async () => {
      await api('/api/mfa/desativar', {
        method: 'POST',
        body: JSON.stringify({ senha: $('#sg-senha').value, codigo: $('#sg-codigo').value }),
      });
      alerta('Segundo fator desligado.');
    });
    $('#modal-ok').textContent = 'Desligar';
    return;
  }

  const ini = await api('/api/mfa/iniciar', { method: 'POST' });
  abrirModal('Ligar o segundo fator', `
    <p class="page-desc">Abra seu aplicativo autenticador (Google Authenticator, Authy,
      1Password, o que você usar) e cadastre esta chave:</p>
    <p style="text-align:center;margin:.6rem 0">
      <code style="font-size:1.05rem;letter-spacing:.08em;user-select:all;background:#fff;
        border:1px solid #dfe8f2;border-radius:6px;padding:.4rem .6rem;display:inline-block">
        ${esc(ini.segredoLegivel)}</code>
    </p>
    <p class="page-desc">No aplicativo, escolha <b>“inserir chave manualmente”</b> ou
      <b>“inserir código de configuração”</b>. O nome da conta pode ser qualquer coisa.</p>
    <div class="campo">
      <label class="fl" for="sg-conf">Digite o código que o aplicativo mostrar</label>
      <input type="text" id="sg-conf" inputmode="numeric" maxlength="6" placeholder="000000">
    </div>
    <p class="page-desc">Só depois que este código conferir é que o segundo fator liga —
      assim um erro de cadastro aparece agora, e não no próximo login.</p>
  `, async () => {
    const r = await api('/api/mfa/confirmar', {
      method: 'POST', body: JSON.stringify({ codigo: $('#sg-conf').value }),
    });
    mostrarCodigosRecuperacao(r.codigosRecuperacao);
  });
  $('#modal-ok').textContent = 'Confirmar';
}

function mostrarCodigosRecuperacao(codigos) {
  // Aparecem UMA vez. Só o hash fica no banco — nem administrador vê de novo.
  setTimeout(() => {
    abrirModal('Guarde estes códigos agora', `
      <p class="page-desc"><b>Segundo fator ligado.</b> Estes oito códigos são a sua
        saída se o celular sumir. Cada um serve uma vez.</p>
      <p class="page-desc"><b>Eles não aparecem de novo</b> — no banco fica só o
        embaralhado deles. Copie para onde você guarda senhas, ou imprima.</p>
      <pre style="background:#fff;border:1px solid #dfe8f2;border-radius:6px;padding:.7rem;
        font-size:.95rem;line-height:1.8;user-select:all;text-align:center">${codigos.map(esc).join('\n')}</pre>
    `, async () => {});
    $('#modal-cancelar').classList.add('hidden');
    $('#modal-ok').textContent = 'Guardei';
  }, 30);
}

$('#btn-seguranca').addEventListener('click', (e) => {
  e.preventDefault();
  abrirSeguranca().catch((err) => alerta(err.message));
});

$('#btn-sair').addEventListener('click', async (e) => {
  e.preventDefault();
  // Só mostra o login DEPOIS de o servidor confirmar. O `catch {}` seguido de
  // mostrarLogin() pintava a tela de deslogado sem revogar a sessão: numa
  // máquina compartilhada, a próxima pessoa dava F5 e entrava com o cookie
  // ainda válido. É o mesmo padrão de engolir erro, agora no cliente.
  try {
    await api('/api/logout', { method: 'POST' });
    mostrarLogin();
  } catch (err) {
    alerta('Não consegui encerrar a sessão no servidor. '
      + 'Você continua conectado — tente de novo antes de deixar este computador.');
  }
});

/* Preenche o formulario com o par de teste do modo local, se houver.
   Fica separado de proposito: o cartao chama na carga e o mostrarLogin chama
   depois de sair, e as duas coisas acontecem em ordem imprevisivel. */
function preencherDemo() {
  if (!estado.demo) return false;
  $('#login-email').value = estado.demo.email;
  $('#login-senha').value = estado.demo.senha;
  return true;
}

function mostrarLogin() {
  $('#tela-app').classList.add('hidden');
  $('#tela-login').classList.remove('hidden');
  // Desfaz a segunda etapa: voltar ao login com os campos travados e o botão
  // sumido deixaria a tela num beco sem saída.
  estado.desafioMfa = null;
  $('#passo-mfa').classList.add('hidden');
  $('#mfa-codigo').value = '';
  $('#login-email').disabled = false;
  $('#login-senha').disabled = false;
  $('#btn-entrar').classList.remove('hidden');
  // Limpar a senha ao voltar para o login e correto — mas no modo local a tela
  // deve voltar pronta. Foi bug de verdade: o cartao preenchia na carga e o
  // boot, que roda depois e cai aqui quando nao ha sessao, apagava o campo.
  // O resultado dependia de qual fetch terminava primeiro.
  if (!preencherDemo()) $('#login-senha').value = '';
}

// ------------------------------------------------------------------ shell

$$('#nav button').forEach((b) => b.addEventListener('click', () => irPara(b.dataset.view)));

/* Fornecedores e padroes sao POR EMPRESA — o banco sempre separou
   (UNIQUE tenant + empresa + CNPJ), mas a tela nao dizia, e um menu chamado
   "Cadastros" com as tres juntas dava a entender que a lista era global.
   Agora o titulo dessas telas carrega o nome da empresa selecionada. */
function nomeEmpresaAtual() {
  const e = (estado.empresas || []).find((x) => x.id === estado.empresaId);
  return e ? e.razao_social : null;
}

function marcarEscopo() {
  const nome = nomeEmpresaAtual();
  for (const id of ['#escopo-fornecedores', '#escopo-regras', '#escopo-relatorios', '#escopo-xml']) {
    const el = $(id);
    if (el) el.textContent = nome ? `de ${nome}` : 'nenhuma empresa selecionada';
  }
}

const TELAS = ['v1', 'v2', 'v3', 'vOriginal', 'vEmpresas', 'vFornecedores', 'vRegras', 'vRelatorios', 'vUsuarios', 'vPapeis'];

function telaAtual() {
  return TELAS.find((v) => !$('#' + v).classList.contains('hidden')) ?? 'v1';
}

/**
 * O endereco guarda empresa, tela e nota aberta (#e=…&t=…&n=…). Atualizar a pagina
 * (F5) ou voltar do navegador reabre o mesmo lugar - antes voltava sempre para a
 * lista, e ela tinha que achar a nota de novo (audio de 23/09).
 */
function gravarEndereco(view = telaAtual()) {
  const p = new URLSearchParams();
  if (estado.empresaId) p.set('e', estado.empresaId);
  p.set('t', view);
  if ((view === 'v2' || view === 'vOriginal') && estado.notaAberta?.nota?.id) p.set('n', estado.notaAberta.nota.id);
  try { history.replaceState(null, '', '#' + p.toString()); } catch { /* sem historia: segue */ }
}

async function restaurarEndereco() {
  const p = new URLSearchParams(location.hash.slice(1));
  const e = p.get('e');
  if (e && e !== estado.empresaId && estado.empresas.some((x) => x.id === e)) {
    $('#sel-empresa').value = e;
    await trocarEmpresa(e);
  }
  const t = p.get('t');
  const n = p.get('n');
  if (n && (t === 'v2' || t === 'vOriginal')) {
    try { await abrirNota(n); return; } catch { /* nota apagada ou sem acesso: fica na lista */ }
  }
  if (t && TELAS.includes(t) && t !== 'v2' && t !== 'vOriginal') irPara(t);
}

function irPara(view) {
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  TELAS.forEach((v) => $('#' + v).classList.toggle('hidden', v !== view));
  marcarEscopo();
  gravarEndereco(view);
  if (view === 'vEmpresas') renderEmpresas();
  if (view === 'vFornecedores') carregarFornecedores();
  if (view === 'vRegras') carregarRegras();
  if (view === 'v3') abrirXmlCorrigido();
  if (view === 'vRelatorios') abrirRelatorios();
  if (view === 'vUsuarios') carregarUsuarios();
  if (view === 'vPapeis') carregarPapeis();
}

$('#sel-empresa').addEventListener('change', (e) => trocarEmpresa(e.target.value));

async function trocarEmpresa(empresaId) {
  estado.empresaId = empresaId;
  estado.notaAberta = null;
  marcarEscopo();
  // Competencia e recorte da empresa ANTERIOR. Levar "setembro/2026" para uma
  // empresa que so tem notas de 2025 devolveria lista vazia sem explicacao.
  estado.competencia = '';
  estado.importacaoId = '';
  await carregarCompetencias();
  await carregarImportacoes();
  // Trocar de empresa nao pode deixar na tela a lista da empresa anterior.
  const aberta = ['vFornecedores', 'vRegras', 'vRelatorios', 'v3']
    .find((v) => !$('#' + v).classList.contains('hidden'));
  if (aberta === 'vFornecedores') await carregarFornecedores();
  if (aberta === 'vRegras') await carregarRegras();
  if (aberta === 'vRelatorios') await abrirRelatorios();
  if (aberta === 'v3') await abrirXmlCorrigido();
  await carregarNotas();
  gravarEndereco();
}

/**
 * Ano e mes, nesta ordem, porque e assim que a contadora procura: primeiro o
 * exercicio, depois a competencia. Uma empresa com 200 notas nao se acha numa
 * lista unica - foi o proprio pedido dela, falando de "empresas aqui que sao
 * 200 notas e que a gente tambem nao vai fazer tudo no mesmo dia".
 *
 * As opcoes vem de /competencias, NAO das notas ja filtradas. Antes elas saiam
 * do resultado da busca, e o seletor se destruia sozinho: escolhia setembro, a
 * busca voltava so com setembro, o seletor era remontado a partir dela, e
 * agosto sumia da lista. Quem nao descobrisse que precisava voltar em "todas"
 * concluia que as notas de agosto tinham sumido do sistema.
 */
$('#sel-ano').addEventListener('change', async () => {
  desenharMeses();
  await aplicarCompetencia();
});

$('#sel-mes').addEventListener('change', aplicarCompetencia);

async function aplicarCompetencia() {
  const ano = $('#sel-ano').value;
  const mes = $('#sel-mes').value;
  // Mes sem ano nao existe como filtro: "setembro" de qual exercicio?
  estado.competencia = ano && mes ? `${ano}-${mes}` : ano || '';
  await carregarNotas();
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** [{competencia:'2026-09', notas:4}] da empresa inteira, nao do filtro. */
async function carregarCompetencias() {
  if (!estado.empresaId) return;
  try {
    estado.competencias = await api(`/api/empresas/${estado.empresaId}/competencias`);
  } catch {
    estado.competencias = [];
  }
  desenharAnos();
  desenharMeses();
}

function desenharAnos() {
  const sel = $('#sel-ano');
  const anos = [...new Set(estado.competencias.map((c) => c.competencia.slice(0, 4)))].sort().reverse();
  const contar = (a) => estado.competencias
    .filter((c) => c.competencia.startsWith(a))
    .reduce((s, c) => s + c.notas, 0);
  const atual = sel.value;
  sel.innerHTML = '<option value="">todos</option>' +
    anos.map((a) => `<option value="${a}">${a} (${contar(a)})</option>`).join('');
  sel.value = anos.includes(atual) ? atual : '';
}

function desenharMeses() {
  const sel = $('#sel-mes');
  const ano = $('#sel-ano').value;
  const atual = sel.value;

  // Sem ano escolhido nao ha mes para escolher, e o seletor diz isso em vez de
  // ficar habilitado e vazio.
  if (!ano) {
    sel.innerHTML = '<option value="">escolha o ano</option>';
    sel.disabled = true;
    sel.value = '';
    return;
  }

  sel.disabled = false;
  const doAno = estado.competencias
    .filter((c) => c.competencia.startsWith(ano))
    .sort((a, b) => a.competencia.localeCompare(b.competencia));
  sel.innerHTML = '<option value="">o ano todo</option>' +
    doAno.map((c) => {
      const m = c.competencia.slice(5, 7);
      return `<option value="${m}">${MESES[Number(m) - 1] ?? m} (${c.notas})</option>`;
    }).join('');
  sel.value = doAno.some((c) => c.competencia.slice(5, 7) === atual) ? atual : '';
}

async function iniciar() {
  estado.eu = await api('/api/eu');
  $('#usuario-nome').textContent = estado.eu.nome;
  $('#usuario-email').textContent = estado.eu.email;
  $('#rodape-ambiente').textContent = 'sessão ativa';

  $('#tela-login').classList.add('hidden');
  $('#tela-app').classList.remove('hidden');

  // A tela esconde; o servidor decide. Estas linhas são conveniência, não
  // segurança — cada rota confere a permissão por conta própria.
  $('#btn-nova-empresa').classList.toggle('hidden', !pode('empresas.criar'));
  $('#btn-novo-usuario').classList.toggle('hidden', !pode('usuarios.criar'));
  $('#btn-convidar').classList.toggle('hidden', !pode('usuarios.convidar'));
  $('#btn-novo-papel').classList.toggle('hidden', !pode('papeis.gerenciar'));
  for (const [botao, permissao] of [['vUsuarios', 'usuarios.visualizar'], ['vPapeis', 'papeis.gerenciar']]) {
    const b = document.querySelector(`#nav button[data-view="${botao}"]`);
    if (b) b.classList.toggle('hidden', !pode(permissao));
  }

  $('#btn-ultimas')?.classList.toggle('hidden', !pode('auditoria.visualizar'));
  await carregarEmpresas();
  montarSeletorCfop();
  await restaurarEndereco();
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
  marcarEscopo();
  await carregarImportacoes();
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

// Importacao: uma de cada vez, em lotes, com contagem na tela.
//
// O primeiro lote real tinha 78 arquivos. Ia tudo numa requisicao so, o log
// escrevia "enviando 78 arquivo(s)..." e congelava; parecia travado, e a
// contadora soltava os arquivos de novo. Reimportar nunca apagou nada (o
// servidor devolve "duplicada"), mas ela nao tinha como saber.
//
//   1. TRAVA: com importacao em voo, soltar de novo nao dispara nada - e diz por que.
//   2. LOTES de 20: a contagem anda na tela e nenhuma requisicao fica gigante.
//   3. O resultado fala a lingua dela: o que ja existia, o que ja estava
//      conferido ("nada foi alterado") e os EVENTOS (cancelamento) no topo.
const TAMANHO_LOTE_IMPORT = 20;
let importando = false;

function travarImportacao(sim) {
  importando = sim;
  drop.classList.toggle('ocupado', sim);
  drop.setAttribute('aria-busy', sim ? 'true' : 'false');
  inputArquivo.disabled = sim;
}

async function enviar(arquivos) {
  if (importando) {
    return alerta('Já existe uma importação em andamento. Espere ela terminar — a contagem está andando logo abaixo.');
  }
  if (!estado.empresaId) return alerta('Escolha uma empresa antes de importar.');
  const xmls = arquivos.filter((f) => f.name.toLowerCase().endsWith('.xml'));
  if (xmls.length === 0) return alerta('Nenhum arquivo .xml no que foi solto.');

  const log = $('#log-import');
  log.classList.remove('hidden');
  const empresaDoEnvio = estado.empresaId;
  // Um id por envio: os lotes de 20 viram UMA importacao na lista.
  const envioId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2));
  const tot = { importadas: 0, duplicadas: 0, duplicadasTratadas: 0, eventos: 0, recusadas: 0 };
  const linhas = [];
  let feitos = 0;

  const placar = () =>
    `${tot.importadas} importada(s) · ${tot.duplicadas} já existia(m)` +
    (tot.eventos ? ` · ${tot.eventos} evento(s)` : '') +
    ` · ${tot.recusadas} recusada(s)`;

  travarImportacao(true);
  log.textContent = `importando… 0 de ${xmls.length}\nnão precisa enviar de novo: a contagem anda aqui.`;
  try {
    for (let i = 0; i < xmls.length; i += TAMANHO_LOTE_IMPORT) {
      const fatia = xmls.slice(i, i + TAMANHO_LOTE_IMPORT);
      const form = new FormData();
      for (const f of fatia) form.append('arquivos', f, f.name);
      form.append('envio', envioId);
      try {
        const r = await api(`/api/empresas/${empresaDoEnvio}/importar`, { method: 'POST', body: form });
        tot.importadas += r.importadas;
        tot.duplicadas += r.duplicadas;
        tot.duplicadasTratadas += r.duplicadasTratadas ?? 0;
        tot.eventos += r.eventos ?? 0;
        tot.recusadas += r.recusadas;
        linhas.push(...r.arquivos);
      } catch (e) {
        // Um lote que falha nao derruba os outros, e nao some: vira recusa com motivo.
        tot.recusadas += fatia.length;
        linhas.push(...fatia.map((f) => ({ arquivo: f.name, status: 'recusada', motivo: 'o envio falhou: ' + e.message })));
      }
      feitos += fatia.length;
      log.textContent = `importando… ${feitos} de ${xmls.length}\n${placar()}`;
    }

    log.textContent = textoResultadoImportacao(xmls.length, tot, linhas);

    // Nota nova pode trazer competencia nova: o seletor tem que saber dela.
    await carregarCompetencias();
    await carregarImportacoes();
    await carregarNotas();
  } catch (e) {
    log.textContent = 'falhou: ' + e.message;
  } finally {
    travarImportacao(false);
    inputArquivo.value = '';
  }
}

/** O resultado de uma importacao em texto — usado na hora e ao reabrir a importacao depois. */
function textoResultadoImportacao(totalArquivos, tot, linhas) {
  const marca = { importada: '✓', duplicada: '=', evento: '⚠', recusada: '✕' };
  const texto = (a) => {
    const extra = a.status === 'importada'
      ? `${a.itens} itens${a.preenchidos ? `, ${a.preenchidos} já preenchidos pelo padrão` : ''}${a.motivo ? ' · ' + a.motivo : ''}`
      : (a.motivo ?? '');
    return `${marca[a.status] ?? '?'} ${a.arquivo}  ${extra}`;
  };
  // O que pede acao dela vem primeiro: evento, depois recusa. O resto e conferencia.
  const ordem = { evento: 0, recusada: 1, importada: 2, duplicada: 3 };
  const ordenadas = [...linhas].sort((a, b) => (ordem[a.status] ?? 9) - (ordem[b.status] ?? 9));

  const placar = `${tot.importadas} importada(s) · ${tot.duplicadas} já existia(m)` +
    (tot.eventos ? ` · ${tot.eventos} evento(s)` : '') + ` · ${tot.recusadas} recusada(s)`;
  const cabecalho = [`${totalArquivos} arquivo(s) · ${placar}`];
  if (tot.duplicadas > 0) {
    cabecalho.push(
      tot.duplicadasTratadas > 0
        ? `${tot.duplicadas} nota(s) já estavam no sistema — ${tot.duplicadasTratadas} com itens que você já conferiu. Nenhuma foi alterada.`
        : `${tot.duplicadas} nota(s) já estavam no sistema. Nenhuma foi alterada.`,
    );
  }
  if (tot.eventos > 0) {
    cabecalho.push(`ATENÇÃO: ${tot.eventos} arquivo(s) são EVENTO de nota (cancelamento/correção) — veja logo abaixo qual nota.`);
  }
  return cabecalho.join('\n') + '\n\n' + ordenadas.map(texto).join('\n');
}

// ------------------------------------------------------------------ importacoes (lotes)
//
// "Veio uns 70 XML de uma vez. Seria interessante agrupar." Cada envio da tela
// vira uma importacao na lista: da para ver o que entrou AGORA e o que ja
// estava (ela importa quinzenal), filtrar so por ela, e reler o resultado -
// inclusive o aviso de evento de cancelamento, que antes sumia ao sair da tela.

async function carregarImportacoes() {
  const sel = $('#sel-importacao');
  if (!estado.empresaId) { estado.importacoes = []; sel.innerHTML = '<option value="">todas</option>'; return; }
  try {
    estado.importacoes = await api(`/api/empresas/${estado.empresaId}/importacoes`);
  } catch {
    estado.importacoes = [];
  }
  const atual = estado.importacaoId;
  sel.innerHTML = '<option value="">todas as importações</option>' + estado.importacoes.map((i) => {
    const resumo = `${i.arquivos} arquivo(s): ${i.importadas} nota(s)` +
      (i.duplicadas ? `, ${i.duplicadas} já existia(m)` : '') +
      (i.eventos ? `, ${i.eventos} evento(s)` : '') +
      (i.recusadas ? `, ${i.recusadas} recusada(s)` : '');
    return `<option value="${esc(i.id)}">${esc(dataHora(i.criadoEm))}${i.quem ? ' · ' + esc(i.quem) : ''} — ${esc(resumo)}</option>`;
  }).join('');
  sel.value = estado.importacoes.some((i) => i.id === atual) ? atual : '';
  if (sel.value !== atual) estado.importacaoId = '';
  mostrarDetalheImportacao();
}

function mostrarDetalheImportacao() {
  const box = $('#detalhe-importacao');
  const imp = estado.importacoes.find((i) => i.id === estado.importacaoId);
  if (!imp) { box.classList.add('hidden'); box.textContent = ''; return; }
  const tot = {
    importadas: imp.importadas, duplicadas: imp.duplicadas, recusadas: imp.recusadas, eventos: imp.eventos,
    duplicadasTratadas: imp.resultados.filter((r) => r.status === 'duplicada' && (r.itensConferidos ?? 0) > 0).length,
  };
  box.textContent = `Importação de ${dataHora(imp.criadoEm)}${imp.quem ? ' por ' + imp.quem : ''}\n` +
    textoResultadoImportacao(imp.arquivos, tot, imp.resultados);
  box.classList.remove('hidden');
}

document.addEventListener('click', (ev) => {
  const g = ev.target.closest('tr.grupo-fornecedor');
  if (!g) return;
  const k = g.dataset.grupo;
  if (estado.fornecedoresFechados.has(k)) estado.fornecedoresFechados.delete(k); else estado.fornecedoresFechados.add(k);
  renderNotas();
});

$('#sel-importacao').addEventListener('change', (e) => {
  estado.importacaoId = e.target.value;
  mostrarDetalheImportacao();
  renderNotas();
});

$('#btn-agrupar').addEventListener('click', () => {
  estado.agruparFornecedor = !estado.agruparFornecedor;
  try { localStorage.setItem('agruparFornecedor', estado.agruparFornecedor ? '1' : '0'); } catch {}
  $('#btn-agrupar').classList.toggle('on', estado.agruparFornecedor);
  renderNotas();
});
try { estado.agruparFornecedor = localStorage.getItem('agruparFornecedor') === '1'; } catch {}
$('#btn-agrupar').classList.toggle('on', !!estado.agruparFornecedor);

async function carregarNotas() {
  if (!estado.empresaId) return;
  if (estado.competencias.length === 0) await carregarCompetencias();
  const q = estado.competencia ? `?competencia=${estado.competencia}` : '';
  estado.notas = await api(`/api/empresas/${estado.empresaId}/notas${q}`);
  renderNotas();
}

/** O valor que a nota soma: zero se cancelada (o XML continua com o valor original). */
function valorQueConta(n) {
  return n?.cancelada_em ? 0 : (n?.valor_total ?? 0);
}

function renderNotas() {
  const corpo = $('#tbl-notas tbody');
  const vazio = $('#vazio-notas');
  vazio.classList.toggle('hidden', estado.notas.length > 0);

  const totalItens = estado.notas.reduce((s, n) => s + (n.total_itens ?? 0), 0);
  const revisados = estado.notas.reduce((s, n) => s + (n.itens_revisados ?? 0), 0);
  // Nota cancelada vale zero (23/09, NF 419887): fica na lista, fora da soma.
  const valor = estado.notas.reduce((s, n) => s + valorQueConta(n), 0);
  const fornecedores = new Set(estado.notas.map((n) => n.emit_cnpj)).size;

  $('#kpis-notas').innerHTML = [
    ['Notas', estado.notas.length],
    ['Fornecedores', fornecedores],
    ['Itens', totalItens],
    ['Itens revisados', totalItens ? `${revisados}<small> de ${totalItens}</small>` : '—'],
    ['Valor total', 'R$ ' + moeda(valor)],
  ].map(([l, v]) => `<div class="kpi"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('');

  $('#hint-notas').textContent = estado.notas.length ? `${estado.notas.length} nota(s)` : '';

  // Empresa com 200 notas nao se trata num dia. Separar o que ja passou por gente
  // do que ainda nao passou foi o primeiro pedido da contadora depois de usar.
  const tratada = (n) => !!n.cancelada_em || ((n.total_itens ?? 0) > 0 && (n.itens_revisados ?? 0) >= n.total_itens);
  const imp = estado.importacoes.find((i) => i.id === estado.importacaoId);
  const lotesDaImportacao = imp ? new Set(imp.lotes) : null;
  const visiveis = estado.notas.filter((n) => {
    if (lotesDaImportacao && !lotesDaImportacao.has(n.lote_id)) return false;
    if (estado.filtroNotas === 'tratar') return !tratada(n);
    if (estado.filtroNotas === 'tratadas') return tratada(n);
    return true;
  });

  if (visiveis.length === 0) {
    corpo.innerHTML = `<tr><td colspan="8" class="vazio">${
      lotesDaImportacao ? 'Nenhuma nota desta importação neste filtro.'
      : estado.filtroNotas === 'tratadas' ? 'Nenhuma nota tratada ainda.' : 'Nenhuma nota pendente.'
    }</td></tr>`;
    return;
  }

  const linhaNota = (n) => {
    const total = n.total_itens ?? 0;
    const feitos = n.itens_revisados ?? 0;
    const pendentes = total - feitos;

    // Três estados, não dois. "Comecei e parei no meio" é o caso normal numa
    // empresa de 200 notas, e era exatamente o que não dava para ver: tudo que
    // não estava 100% aparecia igual a nunca tocada.
    const estagio = n.cancelada_em ? 'cancelada'
      : total === 0 ? 'vazia' : feitos === 0 ? 'nova' : pendentes === 0 ? 'pronta' : 'andando';
    const selo = {
      cancelada: '<span class="tag dan" title="Nota cancelada: vale zero e fica fora das somas, dos relatórios e da exportação">CANCELADA</span>',
      vazia: '<span class="tag mut">sem itens</span>',
      nova: `<span class="tag warn">${pendentes} a revisar</span>`,
      andando: `<span class="tag info">${feitos} de ${total} conferidos</span>`,
      pronta: '<span class="tag ok">✓ tratada</span>',
    }[estagio];

    // O botão diz o que resta fazer. Azul de "Tratar" numa nota pronta convida
    // para um trabalho que já foi feito; e quem parou no meio precisa saber que
    // é para continuar, não para começar de novo.
    const acao = {
      cancelada: { rotulo: 'Ver →', classe: '', dica: 'Nota cancelada' },
      vazia: { rotulo: 'Abrir →', classe: '', dica: 'Nota sem itens' },
      nova: { rotulo: 'Tratar →', classe: 'primary', dica: 'Começar a tratar esta nota' },
      andando: { rotulo: 'Continuar →', classe: 'primary', dica: `Faltam ${pendentes} item(ns)` },
      pronta: { rotulo: 'Ver →', classe: '', dica: 'Abrir para conferir ou ajustar' },
    }[estagio];

    return `<tr class="nota-${estagio}">
      <td>${dataCurta(n.dh_emi)}</td>
      <td class="mono">${esc(n.numero)}</td>
      <td>${esc(n.emit_nome ?? n.emit_cnpj)}<span class="porque">${esc(n.emit_cnpj)}</span></td>
      <td class="mono tiny">${esc(String(n.chave).slice(0, 12))}…</td>
      <td class="num">${n.cancelada_em
        ? `<span title="Valor do XML: R$ ${moeda(n.valor_total)} — nota cancelada, vale zero">0,00</span>`
        : moeda(n.valor_total)}</td>
      <td class="num">${n.total_itens ?? 0}</td>
      <td>${selo}</td>
      <td class="acoes">
        <button class="btn sm ${acao.classe}" data-nota="${n.id}" title="${acao.dica}">${acao.rotulo}</button>
        ${pode('notas.apagar') ? `<button class="btn sm perigo" data-apagar-nota="${n.id}" title="Apagar esta nota">Apagar</button>` : ''}
      </td>
    </tr>`;
  };

  if (!estado.agruparFornecedor) {
    corpo.innerHTML = visiveis.map(linhaNota).join('');
    return;
  }

  // Dobrado por fornecedor. A decisao de CFOP e quase sempre por fornecedor
  // (medido: 2 de 22 misturam), entao e assim que ela ganha tempo: trata a
  // primeira nota, fixa o padrao do fornecedor, e as outras vem prontas.
  const grupos = new Map();
  for (const n of visiveis) {
    const k = n.emit_cnpj ?? '?';
    const g = grupos.get(k) ?? { cnpj: k, nome: n.emit_nome ?? k, notas: [], itens: 0, revisados: 0, valor: 0 };
    g.notas.push(n);
    g.itens += n.total_itens ?? 0;
    g.revisados += n.itens_revisados ?? 0;
    g.valor += valorQueConta(n);
    grupos.set(k, g);
  }
  const ordenados = [...grupos.values()].sort((a, b) => b.notas.length - a.notas.length || a.nome.localeCompare(b.nome, 'pt-BR'));
  corpo.innerHTML = ordenados.map((g) => {
    const fechado = estado.fornecedoresFechados.has(g.cnpj);
    const pronto = g.itens > 0 && g.revisados >= g.itens;
    return `<tr class="grupo-fornecedor${pronto ? ' pronto' : ''}" data-grupo="${esc(g.cnpj)}">
      <td colspan="8">
        <span class="seta">${fechado ? '▸' : '▾'}</span>
        <b>${esc(g.nome)}</b>
        <span class="grupo-meta">${g.notas.length} nota(s) · ${g.itens} itens · ${g.revisados} conferidos · R$ ${moeda(g.valor)}</span>
        ${pronto ? '<span class="tag ok">✓ tudo tratado</span>' : g.revisados === 0 ? `<span class="tag warn">${g.itens} a revisar</span>` : `<span class="tag info">faltam ${g.itens - g.revisados}</span>`}
      </td></tr>` + (fechado ? '' : g.notas.map(linhaNota).join(''));
  }).join('');
}

// Os botoes da lista de notas escutam pela TABELA, uma vez so, e nao botao a botao
// depois de cada desenho. Em 18/09 a lista ganhou um segundo jeito de ser
// desenhada (agrupada por fornecedor); o caminho nao agrupado - o padrao - saia
// com `return` antes da ligacao, e Tratar/Ver/Continuar/Apagar ficaram mortos
// para todo mundo ate 22/09. Ouvinte na tabela nao depende de como ela foi
// desenhada, nem agora nem no proximo jeito que aparecer.
$('#tbl-notas').addEventListener('click', (ev) => {
  const abrir = ev.target.closest('button[data-nota]');
  if (abrir) return abrirNota(abrir.dataset.nota);
  const apagar = ev.target.closest('button[data-apagar-nota]');
  if (apagar) return apagarNota(apagar.dataset.apagarNota);
});

/**
 * Apagar nota. Some com os itens e com o XML guardado; as REGRAS aprendidas
 * ficam, porque são conhecimento do escritório sobre o fornecedor e não
 * pertencem à nota que por acaso as ensinou.
 */
function apagarNota(id) {
  const n = estado.notas.find((x) => x.id === id);
  abrirModal('Apagar nota', `
    <p>Apagar a nota <b>${esc(n?.numero ?? '')}</b> de ${esc(n?.emit_nome ?? '')}?</p>
    <p class="porque">Somem a nota, os ${n?.total_itens ?? 0} itens e o XML arquivado.
      As regras já aprendidas com ela continuam valendo.</p>
    <p class="porque">Não dá para desfazer.</p>
  `, async () => {
    await api('/api/notas/' + id, { method: 'DELETE' });
    await carregarNotas();
  });
  $('#modal-ok').textContent = 'Apagar';
  $('#modal-ok').classList.add('perigo');
}

// ------------------------------------------------------------------ ambiente 2

$('#btn-voltar-notas').addEventListener('click', () => irPara('v1'));
$('#btn-ver-xml').addEventListener('click', () => irPara('v3'));

// ------------------------------------------------------------------ nota original
//
// "Preciso conseguir abrir o XML original, numa visao facil de visualizar e
// comparar com o que o app esta trazendo." A nota e lida AGORA do arquivo guardado
// (nunca do banco), e o servidor cruza item a item com o que o app mostra. A tela
// so desenha: o que confere fica calmo; divergencia de leitura grita.

$('#btn-ver-original').addEventListener('click', () => abrirOriginal());
$('#orig-voltar').addEventListener('click', () => irPara('v2'));
$('#orig-baixar').addEventListener('click', () => {
  if (estado.notaAberta) baixar(`/api/notas/${estado.notaAberta.nota.id}/original?formato=xml`);
});

// Dois jeitos de ver o original: como NOTA (legivel) e como XML (o arquivo cru,
// indentado, com os campos que o sistema le em destaque). O XML vem da mesma rota
// do download - e o arquivo guardado, sem passar por nenhuma leitura nossa.
const CAMPOS_LIDOS = ['xProd', 'cProd', 'cEAN', 'NCM', 'CEST', 'CFOP', 'uCom', 'qCom', 'vUnCom', 'vProd', 'vNF', 'nNF', 'chNFe'];

function indentarXml(xml) {
  let nivel = 0;
  return xml.replace(/>\s*</g, '>\n<').split('\n').map((l) => {
    if (/^<\//.test(l)) nivel = Math.max(0, nivel - 1);
    const linha = '  '.repeat(nivel) + l;
    if (/^<[^!?\/]([^>]*[^\/])?>$/.test(l)) nivel += 1;
    return linha;
  }).join('\n');
}

async function mostrarModoOriginal(modo) {
  $$('#orig-modo button').forEach((b) => b.classList.toggle('on', b.dataset.modo === modo));
  $('#orig-corpo').classList.toggle('hidden', modo !== 'nota');
  $('#orig-xml').classList.toggle('hidden', modo !== 'xml');
  if (modo !== 'xml' || !estado.notaAberta) return;
  const pre = $('#orig-xml-pre');
  if (pre.dataset.nota === estado.notaAberta.nota.id) return;
  pre.textContent = 'lendo o arquivo…';
  try {
    const r = await fetch(`/api/notas/${estado.notaAberta.nota.id}/original?formato=xml`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('o servidor respondeu ' + r.status);
    let texto = indentarXml(await r.text());
    // Assinatura e certificado sao centenas de linhas de base64: recolhidos, com aviso.
    texto = texto.replace(/(<(?:X509Certificate|SignatureValue)>)[^<]{80,}(<\/)/g, '$1… (recolhido — está íntegro no arquivo) …$2');
    const re = new RegExp(`(&lt;(${CAMPOS_LIDOS.join('|')})&gt;)([^&]*)(&lt;\\/\\2&gt;)`, 'g');
    pre.innerHTML = esc(texto).replace(re, '$1<mark>$3</mark>$4');
    pre.dataset.nota = estado.notaAberta.nota.id;
  } catch (e) {
    pre.textContent = 'Não consegui abrir o XML: ' + e.message;
  }
}
$$('#orig-modo button').forEach((b) => b.addEventListener('click', () => mostrarModoOriginal(b.dataset.modo)));

async function abrirOriginal() {
  $('#orig-xml-pre').dataset.nota = '';
  mostrarModoOriginal('nota');
  const aberta = estado.notaAberta;
  if (!aberta) return alerta('Abra uma nota primeiro.');
  irPara('vOriginal');
  // No menu, quem fica aceso e o Tratamento: esta tela e um desvio dele.
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === 'v2'));
  const corpo = $('#orig-corpo');
  $('#orig-titulo').textContent = `nº ${aberta.nota.numero} — ${aberta.nota.emit_nome ?? ''}`;
  corpo.innerHTML = '<div class="card"><div class="body vazio">lendo o XML guardado…</div></div>';

  let r;
  try {
    r = await api(`/api/notas/${aberta.nota.id}/original`);
  } catch (e) {
    corpo.innerHTML = `<div class="card"><div class="body vazio">Não consegui abrir a nota original: ${esc(e.message)}</div></div>`;
    return;
  }
  const n = r.nota;
  const v = (x, casas = 2) => (x === null || x === undefined ? '—'
    : Number(x).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: Math.max(casas, 4) }));
  const doc = (d) => !d ? '—'
    : d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
    : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : d;
  const parte = (titulo, p) => `<div class="orig-parte"><div class="lbl">${titulo}</div>
      <b>${esc(p.nome ?? '—')}</b>${p.fantasia ? `<span class="porque">${esc(p.fantasia)}</span>` : ''}
      <span class="mono tiny">${esc(doc(p.doc))}${p.ie ? ' · IE ' + esc(p.ie) : ''}</span>
      <span class="tiny">${esc([p.endereco, p.municipio, p.uf].filter(Boolean).join(' · ') || '—')}</span></div>`;

  const faixa = r.divergencias === 0
    ? `<div class="faixa ok"><b>✓ Confere.</b> Os ${r.itens.length} itens que o sistema mostra são exatamente os do XML: descrição, código, NCM, CFOP, quantidade e valores.</div>`
    : `<div class="faixa critico"><b>▲ ${r.divergencias} diferença(s) entre o XML e o que o sistema guardou.</b> Isso não deveria acontecer — avise o suporte antes de tratar esta nota.</div>`;

  const divCab = (r.divergenciasCabecalho ?? []).map((d) =>
    `<div class="alerta critico"><span class="marca">▲</span><span>${esc(d.campo)}: no XML “${esc(d.noXml)}”, no sistema “${esc(d.noApp)}”</span></div>`).join('');

  const totais = [['Produtos', 'vProd'], ['Desconto', 'vDesc'], ['Frete', 'vFrete'], ['Outras', 'vOutro'],
    ['ICMS', 'vICMS'], ['ICMS ST', 'vST'], ['IPI', 'vIPI'], ['Total da nota', 'vNF']]
    .filter(([, k]) => k === 'vProd' || k === 'vNF' || (n.totais[k] ?? 0) > 0)
    .map(([l, k]) => `<div class="kpi"><div class="lbl">${l}</div><div class="val">${v(n.totais[k])}</div></div>`).join('');

  const linhas = r.itens.map((i) => {
    const a = i.app;
    const mudouCfop = a && a.cfopEntrada;
    return `<tr class="${i.divergencias.length ? 'estado-bloqueado' : ''}">
      <td class="num tiny">${i.nItem}</td>
      <td>${esc(i.xProd ?? '—')}
        <span class="porque">cód. ${esc(i.cProd ?? '—')}${i.cEAN ? ' · EAN ' + esc(i.cEAN) : ''}</span>
        ${i.descricaoAlterada ? `<span class="orig-app">no sistema: <b>${esc(a.descricao)}</b></span>` : ''}
        ${i.infAdProd ? `<span class="porque">obs.: ${esc(i.infAdProd)}</span>` : ''}
        ${i.divergencias.map((d) => `<div class="alerta critico"><span class="marca">▲</span><span>${esc(d.campo)}: no XML “${esc(d.noXml)}”, no sistema “${esc(d.noApp)}”</span></div>`).join('')}
      </td>
      <td class="mono tiny">${esc(i.NCM ?? '—')}</td>
      <td class="mono tiny">${esc(i.cst ?? '—')}</td>
      <td class="mono"><b>${esc(i.CFOP ?? '—')}</b></td>
      <td class="mono">${mudouCfop ? `<span class="orig-app-cfop">→ ${esc(a.cfopEntrada)}</span>${a.revisado ? ' <span class="tiny">✓</span>' : ''}` : '—'}</td>
      <td class="tiny">${esc(i.uCom ?? '')}</td>
      <td class="num">${v(i.qCom, 0)}</td>
      <td class="num">${v(i.vUnCom)}</td>
      <td class="num">${v(i.vProd)}</td>
      <td class="num tiny">${(i.vICMSST ?? 0) > 0 ? v(i.vICMSST) : ''}</td>
      <td>${i.divergencias.length ? '<span class="selo selo-bloqueado"><span class="ic">▲</span>difere</span>'
        : '<span class="selo selo-pronto"><span class="ic">✓</span>confere</span>'}</td>
    </tr>`;
  }).join('');

  corpo.innerHTML = `
    ${faixa}${divCab}
    <div class="card"><div class="body orig-cabecalho">
      ${parte('Emitente (fornecedor)', n.emit)}
      ${parte('Destinatário', n.dest)}
      <div class="orig-parte"><div class="lbl">Nota</div>
        <b>nº ${esc(n.numero ?? '—')} · série ${esc(n.serie ?? '—')}</b>
        <span class="tiny">${esc(n.natOp ?? '—')}</span>
        <span class="tiny">emitida em ${esc(dataCurta(n.dhEmi))}${n.finalidade ? ' · ' + esc(n.finalidade) : ''}${n.consumidorFinal ? ' · consumidor final' : ''}</span>
        <span class="tiny">${n.protocolo ? `protocolo ${esc(n.protocolo)} — ${esc(n.situacao ?? '')}` : 'sem protocolo de autorização no arquivo'}</span>
        <span class="mono tiny orig-chave">${esc((n.chave ?? '').replace(/(\d{4})(?=\d)/g, '$1 '))}</span>
      </div>
    </div></div>
    <div class="kpis">${totais}</div>
    <div class="card"><header><h2>Itens do XML</h2><span class="hint">à direita do CFOP do fornecedor, o CFOP de entrada que está no sistema</span></header>
      <div class="body tight"><div class="scroll"><table>
        <thead><tr><th>#</th><th>Produto no XML</th><th>NCM</th><th>CST</th><th>CFOP fornecedor</th><th>CFOP entrada</th><th>Un.</th>
          <th class="num">Qtd.</th><th class="num">Unitário</th><th class="num">Total</th><th class="num">ICMS ST</th><th>Leitura</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table></div></div>
    </div>
    ${r.soNoApp?.length ? `<div class="faixa critico">O sistema tem item(ns) que não existem no XML: nº ${r.soNoApp.join(', ')}.</div>` : ''}
    ${n.pagamentos?.length ? `<div class="card"><div class="body tiny"><b>Pagamento:</b> ${n.pagamentos.map((p) => `${esc(p.forma)} ${v(p.valor)}`).join(' · ')}</div></div>` : ''}
    ${n.infCpl || n.infAdFisco ? `<div class="card"><header><h2>Informações complementares</h2></header>
      <div class="body tiny orig-infcpl">${esc([n.infAdFisco, n.infCpl].filter(Boolean).join('\n\n'))}</div></div>` : ''}`;
}

$('#busca').addEventListener('input', (e) => { estado.busca = e.target.value.toLowerCase(); renderItens(); });
$$('#filtros-notas button').forEach((b) => b.addEventListener('click', () => {
  $$('#filtros-notas button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  estado.filtroNotas = b.dataset.fn;
  renderNotas();
}));

$$('#filtros button').forEach((b) => b.addEventListener('click', () => {
  $$('#filtros button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  estado.filtro = b.dataset.f;
  renderItens();
}));

async function abrirNota(id, itemId = null) {
  estado.notaAberta = await api(`/api/notas/${id}`);
  if (itemId) {
    // Veio de uma busca: a linha procurada tem que estar visivel, entao sem filtro.
    estado.filtro = 'todos';
    estado.busca = '';
    const b = $('#busca'); if (b) b.value = '';
    $$('#filtros button').forEach((x) => x.classList.toggle('on', x.dataset.f === 'todos'));
  }
  irPara('v2');
  renderItens();
  if (itemId) {
    const tr = document.querySelector(`#tbl-itens tr[data-linha="${CSS.escape(itemId)}"]`);
    if (tr) {
      tr.classList.add('linha-procurada');
      tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => tr.classList.remove('linha-procurada'), 4000);
    }
  }
}

const CFOPS = [
  ['1102', 'Compra para revenda'],
  ['1101', 'Compra para industrialização'],
  ['1556', 'Compra de material para uso e consumo'],
  ['1403', 'Compra para revenda — ST'],
  ['1407', 'Compra de material de uso e consumo — ST'],
  ['1551', 'Compra de bem para o ativo imobilizado'],
  ['1202', 'Devolução de venda'],
  ['1949', 'Outra entrada não especificada'],
  ['2102', 'Compra para revenda — outro estado'],
  ['2101', 'Compra para industrialização — outro estado'],
  ['2556', 'Compra de uso e consumo — outro estado'],
  ['2403', 'Compra para revenda com ST — outro estado'],
  ['2949', 'Outra entrada não especificada — outro estado'],
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
    // 'padrao' e 'aprendido' sao o mesmo "ja esta pronto", so que dizendo de onde
    // veio. Sem isto o filtro Prontos passaria a esconder justamente as linhas que
    // o sistema acertou sozinho.
    if (estado.filtro === 'pronto') return e === 'pronto' || e === 'padrao' || e === 'aprendido';
    if (estado.filtro === 'conferido') return e === 'conferido';
    return true;
  });
}

function renderItens() {
  const n = estado.notaAberta;
  const corpo = $('#tbl-itens tbody');
  $('#vazio-itens').classList.toggle('hidden', !!n);
  renderTotaisCfop(n);
  if (!n) { corpo.innerHTML = ''; $('#faixa-resumo').innerHTML = ''; return; }

  $('#titulo-nota').textContent = `Nota ${n.nota.numero} — ${n.nota.emit_nome ?? n.nota.emit_cnpj}`;
  const cancelada = !!n.nota.cancelada_em;
  $('#hint-nota').textContent = cancelada
    ? `${dataCurta(n.nota.dh_emi)} · CANCELADA (XML: R$ ${moeda(n.nota.valor_total)})`
    : `${dataCurta(n.nota.dh_emi)} · R$ ${moeda(n.nota.valor_total)}`;
  const bc = $('#btn-cancelada');
  if (bc) {
    bc.classList.toggle('hidden', !pode('notas.importar'));
    bc.textContent = cancelada ? '↺ Desfazer cancelamento' : '⊘ Marcar como cancelada';
  }

  // A faixa do topo vem pronta do servidor: o critério de gravidade é um só.
  const r = n.resumo;
  const classe = r.criticos > 0 ? 'critico' : r.atencao > 0 ? 'atencao' : 'ok';
  $('#faixa-resumo').innerHTML =
    (cancelada
      ? `<div class="faixa critico"><b>⊘ Nota cancelada</b> — vale zero: fica fora das somas, dos relatórios e do XML corrigido.
           <span class="porque">${esc(n.nota.cancelada_motivo ?? '')}${n.nota.cancelada_em ? ' · ' + dataCurta(n.nota.cancelada_em) : ''}</span></div>`
      : '') +
    `<div class="faixa ${classe}"><b>${esc(r.chamada)}</b>
      ${r.bloqueiaExportacao ? '<span class="tag dan">exportação bloqueada</span>' : ''}
    </div>` +
    // O placar do aprendizado é o número que mede o produto, e é a única prova
    // visível de que ensinar o sistema serviu para alguma coisa. Fica fora da
    // faixa colorida de propósito: é notícia boa, não alarme.
    (r.aprendizado ? `<div class="placar">📚 ${esc(r.aprendizado)}</div>` : '') +
    // O que falta padronizar vive AQUI, e nao em cada linha. Medido nas notas
    // reais: 38 de 38 itens estavam sem descricao padronizada. Um aviso em 100%
    // das linhas nao informa, so ensina a ignorar aviso - e ai ele nao funciona
    // mais nas tres linhas em que importava.
    (r.semDescricaoPadrao > 0
      ? `<div class="placar sutil" title="O CFOP de entrada é a decisão fiscal e já está resolvido. A descrição padronizada é organização do cadastro: sem ela, o XML corrigido sai com o nome que o fornecedor escreveu.">✎ ${r.semDescricaoPadrao} ${
          r.semDescricaoPadrao === 1 ? 'item ainda está' : 'itens ainda estão'
        } com a descrição do fornecedor</div>`
      : '');

  const lista = itensVisiveis();

  // Filtro que nao casa nada tem que DIZER isso. Sem esta linha a tabela some e
  // fica um retangulo branco: nenhum erro, nenhuma mensagem, a nota inteira
  // aparentemente vazia. E a mesma forma do bug do `pode()` - a tela nao quebra,
  // ela mente calada, e quem esta usando conclui que perdeu o trabalho.
  // Visto em producao: nota com 7 itens conferidos, filtro "Prontos", tela em branco.
  if (lista.length === 0) {
    const porque = estado.busca
      ? `Nenhum item com “${esc(estado.busca)}”.`
      : {
          atencao:   'Nenhum item pedindo atenção — a nota está em dia.',
          novo:      'Nenhum produto novo nesta nota.',
          pronto:    'Nenhum item veio pronto do sistema. Os que você já conferiu estão em “Conferidos”.',
          conferido: 'Nenhum item conferido ainda.',
        }[estado.filtro] ?? 'Nenhum item nesta situação.';
    corpo.innerHTML =
      `<tr><td colspan="10" class="vazio">${esc(porque)}
        <button class="btn sm" id="limpar-filtro-itens">Ver todos os ${n.itens.length} itens</button>
      </td></tr>`;
    $('#limpar-filtro-itens')?.addEventListener('click', () => {
      estado.filtro = 'todos';
      estado.busca = '';
      $('#busca').value = '';
      $$('#filtros button').forEach((x) => x.classList.toggle('on', x.dataset.f === 'todos'));
      renderItens();
    });
    return;
  }

  corpo.innerHTML = lista.map((i) => linhaItem(i)).join('');

  // Legenda das cores: so aparece quando ha o que explicar.
  const nCfop = n.itens.filter((i) => i.marcas?.cfopForaDoNormal).length;
  const nNovo = n.itens.filter((i) => i.marcas?.produtoNovo).length;
  const legenda = $('#legenda-marcas');
  if (legenda) {
    legenda.classList.toggle('hidden', nCfop + nNovo === 0);
    legenda.innerHTML =
      (nCfop ? `<span class="etiqueta etiqueta-cfop">◆ CFOP original diferente de 5102 · ${nCfop}</span>` : '') +
      (nNovo ? `<span class="etiqueta etiqueta-novo">＋ produto novo · ${nNovo}</span>` : '');
  }

  $$('#tbl-itens [data-campo]').forEach((el) => {
    el.addEventListener('change', () => salvarCampo(el.dataset.item, el.dataset.campo, el.value));
  });
}

/**
 * Rodape da nota: o total de cada CFOP SO desta nota (pedido da Taís, 22/09).
 * Duas colunas de valor, como ela pediu: o dos produtos (bate com o relatório por
 * produto) e o contábil, com frete e despesas (bate com o total da nota e com o
 * relatório por CFOP). Vem pronto do servidor, pela mesma conta do relatório, e é
 * da nota inteira: filtro e busca da tabela não mudam o rodapé.
 */
function renderTotaisCfop(n) {
  const el = $('#totais-cfop');
  if (!el) return;
  const t = n?.totaisCfop;
  if (!t || !t.linhas?.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  if (t.cancelada) {
    el.innerHTML = `<div class="totais-topo"><b>Total por CFOP desta nota</b>
      <span class="tag dan">nota cancelada · vale R$ 0,00 — fora das somas e dos relatórios</span></div>`;
    return;
  }
  const fecha = Math.abs(t.diferenca) < 0.005;
  el.innerHTML =
    `<div class="totais-topo"><b>Total por CFOP desta nota</b>
       ${!t.valoresLidos
         ? '<span class="tag warn" title="Algum item não tem o XML original guardado; o valor contábil dele entra como o valor do produto">valor contábil incompleto</span>'
         : fecha
           ? `<span class="tag ok">fecha com o total da nota · R$ ${moeda(t.valorNota)}</span>`
           : `<span class="tag dan" title="Total da nota (vNF) menos a soma do valor contábil dos itens">difere do total da nota em R$ ${moeda(t.diferenca)}</span>`}
     </div>
     <table><thead><tr>
       <th>CFOP de entrada</th><th class="num">Itens</th>
       <th class="num">Valor dos produtos</th><th class="num">Valor contábil</th>
     </tr></thead><tbody>` +
    t.linhas.map((l) => `<tr>
       <td><b class="mono">${esc(l.cfop)}</b>${l.natureza ? ` <span class="porque">${esc(l.natureza)}</span>` : ''}</td>
       <td class="num">${l.itens}</td>
       <td class="num">${moeda(l.valor)}</td>
       <td class="num"><b>${moeda(l.valorContabil)}</b></td>
     </tr>`).join('') +
    `</tbody><tfoot><tr>
       <td>Total</td><td class="num">${t.totais.itens}</td>
       <td class="num">${moeda(t.totais.valor)}</td><td class="num">${moeda(t.totais.valorContabil)}</td>
     </tr></tfoot></table>`;
}

/** "produto 174,96 + frete 15,60 + outras 2,99" — o que compõe o valor contábil do item. */
function composicaoContabil(i) {
  const partes = [`produto ${moeda(i.valor_total)}`];
  const soma = (rot, v) => { if (Number(v) > 0) partes.push(`+ ${rot} ${moeda(v)}`); };
  soma('frete', i.v_frete); soma('seguro', i.v_seg); soma('outras despesas', i.v_outro);
  soma('ST', Number(i.v_st ?? 0) + Number(i.v_fcp_st ?? 0)); soma('IPI', i.v_ipi);
  if (Number(i.v_desc) > 0) partes.push(`− desconto ${moeda(i.v_desc)}`);
  return partes.join(' ');
}

function linhaItem(i) {
  const est = i.estilo ?? { estado: 'pronto', icone: '✓', rotulo: 'Pronto' };
  // Linha conferida: o aviso continua escrito (registro do que ela viu), mas apagado -
  // a decisao ja foi tomada. So "sem CFOP" nunca chega aqui conferido.
  const visto = est.estado === 'conferido';
  const alertas = (i.alertas ?? []).map((a) =>
    `<div class="alerta ${a.severidade}${visto ? ' visto' : ''}" title="${visto ? 'Visto e conferido. ' : ''}${esc(a.detalhe)}">
       <span class="marca">${a.severidade === 'critico' ? '▲' : a.severidade === 'atencao' ? '●' : 'ⓘ'}</span>
       <span>${esc(a.titulo)}</span>
     </div>`).join('');

  const proc = selinhoProcedencia(i.procedencia);
  const notaCancelada = !!estado.notaAberta?.nota?.cancelada_em;

  // Terceiro eixo (invariante 9c): o quanto a NOTA foge do normal. Pedido da
  // contadora para a lista "Todos", onde ela trabalha: CFOP original fora do
  // 5102 numa cor, produto novo em outra. A cor sai quando ela confere a linha
  // (linha certa nao ganha cor); a etiqueta em texto fica, porque cor nunca e a
  // unica pista.
  const m = i.marcas ?? {};
  const classesMarca =
    (m.cfopForaDoNormal ? ' marca-cfop' : '') +
    (m.produtoNovo ? ' marca-novo' : '') +
    (i.revisado ? ' marca-apagada' : '');

  return `<tr class="estado-${est.estado}${classesMarca}" data-linha="${esc(i.id)}">
    <td class="num tiny">${i.n_item}</td>
    <td>
      ${esc(i.x_prod_original)}
      ${m.produtoNovo ? '<span class="etiqueta etiqueta-novo" title="Primeira vez que este produto aparece deste fornecedor">＋ NOVO</span>' : ''}
      <span class="porque">cód. ${esc(i.c_prod ?? '—')}${i.c_ean ? ' · EAN ' + esc(i.c_ean) : ''}</span>
      ${alertas ? `<div class="alertas">${alertas}</div>` : ''}
    </td>
    <td class="mono tiny">${esc(i.ncm ?? '—')}</td>
    <td class="mono tiny">${m.cfopForaDoNormal
      ? `<span class="etiqueta etiqueta-cfop" title="O normal é 5102 (venda de mercadoria). Este CFOP de saída é outro: confira o tratamento.">◆ ${esc(i.cfop_original)}</span>`
      : esc(i.cfop_original)}</td>
    <td class="celula-edit">
      <input type="text" value="${esc(i.x_prod_novo ?? '')}" data-item="${i.id}" data-campo="descricao">
    </td>
    <td class="celula-edit">
      <input type="text" class="cfop" maxlength="4" value="${esc(i.cfop_novo ?? '')}"
             data-item="${i.id}" data-campo="cfop">
      ${proc}
      ${podeFixar(i) ? `<button class="btn sm sutil fixar" data-fixar="${i.id}"
         title="Faz deste CFOP o padrão deste produto deste fornecedor. Vale a partir da próxima nota, e já nasce confiável — sem esperar as próximas confirmações.">☆ é sempre assim</button>` : ''}
      ${pode('auditoria.visualizar') ? `<button class="btn sm sutil historico" data-trilha="${i.id}"
         title="O que já mudou neste item, quem mudou e quando">↩ como estava</button>` : ''}
    </td>
    <td class="num">${notaCancelada
      ? `<span title="Valor do XML: ${moeda(i.valor_total)} — nota cancelada, vale zero">0,00</span>`
      : moeda(i.valor_total)}</td>
    <td class="num contabil">${notaCancelada
      ? '<span title="Nota cancelada, vale zero">0,00</span>'
      : i.valores_lidos === 1 && i.valor_contabil != null
      ? `<span title="${esc(composicaoContabil(i))}">${moeda(i.valor_contabil)}</span>`
      : '<span class="tiny" title="Sem o XML original guardado não dá para ler frete e despesas deste item">—</span>'}</td>
    <td>
      <span class="selo selo-${est.estado}"><span class="ic">${est.icone}</span>${esc(est.rotulo)}</span>
      ${i.revisado ? `<span class="porque">${esc(quemConferiu(i))}</span>` : ''}
    </td>
    <td>
      ${i.revisado
        ? `<button class="btn sm sutil" data-desconferir="${i.id}" title="Voltar a marcar como pendente">desfazer</button>`
        : `<button class="btn sm ok" data-conferir="${i.id}">✓ Conferido</button>`}
    </td>
  </tr>`;
}

/**
 * Quando oferecer o "é sempre assim".
 *
 * So faz sentido com CFOP preenchido - fixar vazio nao fixa nada - e nao faz
 * sentido no que JA e padrao fixado, senao o botao vira enfeite que nao muda
 * nada quando clicado.
 *
 * O sistema ja aprende de toda correcao, sem botao nenhum. A diferenca aqui e
 * que a regra nasce VERDE: normalmente ela nasce amarela de proposito (ver uma
 * vez nao e saber) e so amadurece depois de algumas confirmacoes, o que na
 * pratica leva umas quatro notas. Este botao e a contadora dizendo "tenho
 * certeza" e pulando essa fila - decisao dela, nao do sistema.
 */
function podeFixar(i) {
  if (!pode('regras.fixar')) return false;
  if (!String(i.cfop_novo ?? '').trim()) return false;
  return i.procedencia?.fonte !== 'fixada';
}

/**
 * De onde veio o valor que está naquela linha.
 *
 * Isto NÃO é o estado da linha, e a diferença importa. O estado responde "isto
 * precisa de você?"; a procedência responde "quem pôs isto aqui?". São dois eixos,
 * e amarrá-los num só foi o que escondeu o trabalho da contadora: uma regra que ela
 * acabou de ensinar ainda nasce amarela de propósito (ver uma vez não é saber), e a
 * confiança do item só fica verde quando CFOP E descrição estão resolvidos. Na
 * prática isso é a QUARTA nota. Se a marca "veio de você" morasse dentro do estado,
 * ela quase nunca apareceria — e foi exatamente essa a queixa: "se tivesse um jeito
 * de ele ir aparecendo de outra cor o que eu já fiz".
 *
 * Por isso a marca aparece em toda linha, inclusive nas que ainda pedem conferência.
 */
function selinhoProcedencia(p) {
  const fonte = p?.fonte ?? 'nenhuma';
  if (fonte === 'fixada') {
    return `<span class="proc proc-fixada" title="Padrão que a contabilidade fixou para este fornecedor">📌 PADRÃO FIXADO</span>`;
  }
  if (fonte === 'aprendida') {
    const n = Number(p?.usos ?? 0);
    return `<span class="proc proc-aprendida" title="O sistema guardou isto de uma correção de vocês">✓ VOCÊS ENSINARAM${n > 1 ? ` · ${n}x` : ''}</span>`;
  }
  if (fonte === 'manual') {
    return `<span class="proc proc-manual" title="Alguém digitou este valor nesta nota">✎ preenchido por vocês</span>`;
  }
  if (fonte === 'perfil') {
    return `<span class="proc proc-perfil" title="Ninguém ensinou este item ainda — o valor é palpite pelo perfil fiscal da empresa">● palpite do perfil</span>`;
  }
  return '';
}

/** "conferido por fulano, hoje 14:12" — quem assinou aquela linha. */
function quemConferiu(i) {
  const quem = i.revisado_por_nome ? ` por ${i.revisado_por_nome}` : '';
  const quando = i.revisado_em ? ' · ' + dataCurta(i.revisado_em) : '';
  return `conferido${quem}${quando}`;
}

async function salvarCampo(itemId, campo, valor) {
  try {
    await api(`/api/itens/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ mudancas: [{ campo, valor }] }),
    });
    avisarSalvo();
    await recarregarNota();
  } catch (e) {
    alerta(e.message);
  }
}

/**
 * Não existe botão "salvar" porque o sistema grava a cada alteração. Só que
 * gravar em silêncio é igual a não gravar, do ponto de vista de quem usa: a
 * contadora terminou quatro notas sem saber se tinha ficado salvo. Este aviso
 * é a diferença entre as duas coisas.
 */
let sumirAviso = null;
function avisarSalvo(texto = 'Salvo') {
  const el = $('#aviso-salvo');
  if (!el) return;
  el.textContent = '✓ ' + texto;
  el.classList.remove('hidden');
  clearTimeout(sumirAviso);
  sumirAviso = setTimeout(() => el.classList.add('hidden'), 2200);
}

/** Conferir = "olhei e concordo". Não muda valor nenhum; marca que houve gente. */
async function conferirItens(ids) {
  if (!estado.notaAberta || ids.length === 0) return;
  mostrarEspera(`Conferindo ${ids.length} item(ns)…`);
  try {
    const r = await api(`/api/notas/${estado.notaAberta.nota.id}/conferir`, {
      method: 'POST',
      body: JSON.stringify({ itens: ids }),
    });
    avisarSalvo(r.conferidos === 1 ? '1 item conferido' : `${r.conferidos} itens conferidos`);
    await recarregarNota();
    await carregarNotas();
  } catch (e) {
    alerta(e.message);
  } finally {
    esconderEspera();
  }
}

async function desconferirItem(id) {
  try {
    await api(`/api/itens/${id}/desconferir`, { method: 'POST' });
    avisarSalvo('Voltou para pendente');
    await recarregarNota();
    await carregarNotas();
  } catch (e) {
    alerta(e.message);
  }
}

async function recarregarNota() {
  if (!estado.notaAberta) return;
  estado.notaAberta = await api(`/api/notas/${estado.notaAberta.nota.id}`);
  renderItens();
}

document.addEventListener('click', (ev) => {
  const c = ev.target.closest('[data-conferir]');
  if (c) return conferirItens([c.dataset.conferir]);
  const d = ev.target.closest('[data-desconferir]');
  if (d) return desconferirItem(d.dataset.desconferir);
  const f = ev.target.closest('[data-fixar]');
  if (f) return fixarProduto(f.dataset.fixar);
  const t = ev.target.closest('[data-trilha]');
  if (t) return verTrilha(t.dataset.trilha);
});

/**
 * "Me arrependi, nao quero mais, quero ver como que tava."
 *
 * Ultimo pedido da contadora no primeiro uso real, e o unico que faltava. Ate
 * aqui o `desfazer` da linha so tirava a marca de conferido - o VALOR ficava
 * onde ela tinha deixado, e nao havia como saber o que havia antes.
 *
 * A trilha e gravada desde o primeiro dia, com valor_antes e valor_depois. So
 * nao havia como ler.
 */
const ROTULO_CAMPO = {
  cfop: 'CFOP de entrada', descricao: 'Descrição padronizada',
  cst_entrada: 'CST de entrada', conta_contabil: 'Conta contábil',
  credito_icms: 'Crédito de ICMS', credito_pis: 'Crédito de PIS',
  credito_cofins: 'Crédito de COFINS', conferido: 'Conferência',
};

async function verTrilha(itemId) {
  const i = (estado.notaAberta?.itens ?? []).find((x) => x.id === itemId);
  const nome = i?.x_prod_novo || i?.x_prod_original || 'este item';

  let eventos;
  try {
    eventos = await api(`/api/itens/${itemId}/trilha`);
  } catch (e) {
    return avisar('Não consegui ler o histórico: ' + e.message);
  }

  // So o que mudou VALOR interessa para voltar atras; conferencia e outra coisa.
  const comValor = eventos.filter((e) => e.campo && e.campo !== 'conferido' && e.valor_depois !== null);
  const anterior = comValor.find((e) => e.campo === 'cfop' && e.valor_antes);

  const linhas = eventos.length === 0
    ? '<p class="dialogo-texto sutil">Nada mudou neste item desde que a nota entrou.</p>'
    : `<ul class="trilha">${eventos.map((e) => `
        <li>
          <span class="trilha-quando">${esc(dataCurta(e.quando))}</span>
          <span class="trilha-campo">${esc(ROTULO_CAMPO[e.campo] ?? e.campo ?? e.acao)}</span>
          ${e.campo === 'conferido'
            ? '<span class="trilha-valor">conferido</span>'
            : `<span class="trilha-valor">${
                e.valor_antes ? `<s>${esc(e.valor_antes)}</s> → ` : ''
              }<b>${esc(e.valor_depois ?? '—')}</b></span>`}
          <span class="trilha-quem">${esc(e.usuario_email ?? '—')}${
            e.origem && e.origem !== 'manual' ? ` · ${esc(e.origem)}` : ''}</span>
        </li>`).join('')}</ul>`;

  const ok = await confirmar({
    titulo: 'Como estava',
    ok: anterior ? `Voltar o CFOP para ${anterior.valor_antes}` : 'Fechar',
    corpo: `<p class="dialogo-destaque">${esc(nome)}</p>${linhas}${
      anterior
        ? `<p class="dialogo-texto sutil">Voltar atrás também fica registrado — a trilha nunca é apagada.</p>`
        : ''}`,
  });

  // Sem valor anterior, o botao e so "Fechar".
  if (!ok || !anterior) return;

  try {
    await api(`/api/itens/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: anterior.valor_antes }] }),
    });
    avisarSalvo(`CFOP voltou para ${anterior.valor_antes}`);
    await recarregarNota();
  } catch (e) {
    avisar('Não consegui voltar o valor: ' + e.message);
  }
}

/**
 * "É sempre assim": o CFOP daquela linha vira o padrão daquele produto.
 *
 * Escopo deliberadamente estreito - AQUELE produto, DAQUELE fornecedor. Nao
 * toca em nenhum outro item da nota, nao mexe no padrao do fornecedor inteiro,
 * e nao carimba tudo que compartilha o NCM. Quem quer o fornecedor inteiro tem
 * outro botao, com outro aviso.
 */
async function fixarProduto(itemId) {
  const i = (estado.notaAberta?.itens ?? []).find((x) => x.id === itemId);
  if (!i) return;
  const cfop = String(i.cfop_novo ?? '').trim();
  if (!cfop) return alerta('Preencha o CFOP antes de salvar como padrão.');

  const nome = i.x_prod_novo || i.x_prod_original || 'este produto';
  const ok = await confirmar({
    titulo: 'Salvar como padrão deste produto',
    ok: 'Salvar padrão',
    corpo: `
      <p class="dialogo-texto">O CFOP <b>${esc(cfop)}</b> passa a ser o padrão de:</p>
      <p class="dialogo-destaque">${esc(nome)}</p>
      <ul class="dialogo-lista">
        <li>Vale só para este produto <b>deste fornecedor</b></li>
        <li>A próxima nota já vem com ele preenchido</li>
        <li>Não altera nenhum outro item desta nota</li>
      </ul>`,
  });
  if (!ok) return;

  try {
    await api(`/api/itens/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: cfop }], fixar: true }),
    });
    avisarSalvo('Padrão salvo');
    await recarregarNota();
  } catch (e) {
    alerta('Não consegui salvar o padrão: ' + e.message);
  }
}

$('#btn-conferir-visiveis').addEventListener('click', () => {
  const pendentes = itensVisiveis().filter((i) => !i.revisado);
  if (pendentes.length === 0) return alerta('Tudo que está na tela já foi conferido.');
  conferirItens(pendentes.map((i) => i.id));
});

/**
 * Salvar o padrao de TODOS de uma vez - cada um com o SEU proprio CFOP.
 *
 * Nao confundir com "Fixar para o fornecedor", que aplica UM CFOP escolhido a
 * tudo que estiver na tela. Aqui nenhum valor muda: o que ja esta preenchido
 * vira padrao daquele produto. E o caminho normal numa nota grande - o leiaute
 * da NF-e admite ate 990 itens, e ninguem clica 990 vezes.
 *
 * Uma requisicao so. A versao obvia seria um laco de requisicoes aqui no
 * navegador, uma por item: minutos numa nota grande, e uma falha no meio deixa
 * metade feito sem ninguem saber.
 */
$('#btn-fixar-visiveis').addEventListener('click', async () => {
  if (!estado.notaAberta) return;
  const alvos = itensVisiveis().filter((i) => podeFixar(i));
  if (alvos.length === 0) {
    return alerta('Não há item para salvar: ou já são padrão, ou estão sem CFOP.');
  }

  const semCfop = itensVisiveis().filter((i) => !String(i.cfop_novo ?? '').trim()).length;
  const ok = await confirmar({
    titulo: 'Salvar o padrão de todos',
    ok: `Salvar ${alvos.length} padrão(ões)`,
    corpo: `
      <p class="dialogo-texto">
        <b>${alvos.length} item(ns)</b> terão o seu CFOP salvo como padrão daquele produto.
      </p>
      <ul class="dialogo-lista">
        <li>Cada item guarda o <b>seu próprio</b> CFOP — nenhum valor é alterado</li>
        <li>A partir da próxima nota deste fornecedor eles já vêm preenchidos</li>
        ${semCfop > 0 ? `<li>${semCfop} item(ns) sem CFOP serão pulados</li>` : ''}
      </ul>`,
  });
  if (!ok) return;

  mostrarEspera(`Salvando ${alvos.length} padrão(ões)…`);
  try {
    const r = await api(`/api/notas/${estado.notaAberta.nota.id}/fixar-padrao`, {
      method: 'POST', body: JSON.stringify({ itens: alvos.map((i) => i.id) }),
    });
    avisarSalvo(`${r.fixados} padrão(ões) salvo(s)`);
    await recarregarNota();
  } catch (e) {
    alerta('Não consegui salvar os padrões: ' + e.message);
  } finally {
    esconderEspera();
  }
});

$('#btn-bulk-nota').addEventListener('click', () => aplicarEmLote('item'));
$('#btn-bulk-fornecedor').addEventListener('click', () => aplicarEmLote('fornecedor'));

async function aplicarEmLote(escopo) {
  const cfop = $('#bulk-cfop').value;
  if (!cfop) return alerta('Escolha um CFOP na lista antes de aplicar.');
  if (!estado.notaAberta) return;

  const alvos = itensVisiveis();

  // A caixa antiga falava do padrao futuro e calava sobre o presente: o botao
  // TAMBEM sobrescreve o CFOP de todos os itens visiveis. Numa nota com CFOPs
  // misturados isso achata tudo, e quem clicou nao foi avisado.
  if (escopo === 'fornecedor') {
    const mudam = alvos.filter((i) => String(i.cfop_novo ?? '').trim() !== cfop);
    const ok = await confirmar({
      titulo: 'Fixar o padrão do fornecedor',
      ok: 'Fixar padrão',
      perigo: true,
      corpo: `
        <p class="dialogo-texto">
          O CFOP <b>${esc(cfop)}</b> passa a ser o padrão deste fornecedor nesta empresa.
        </p>
        <ul class="dialogo-lista">
          <li>Vale para <b>qualquer produto dele</b>, inclusive os que ainda não apareceram</li>
          ${mudam.length > 0
            ? `<li class="dialogo-atencao">E <b>troca o CFOP de ${mudam.length} item(ns)</b> que estão na tela agora</li>`
            : '<li>Nenhum item da tela muda de valor — todos já estão com este CFOP</li>'}
        </ul>
        ${mudam.length > 0 ? `<p class="dialogo-texto sutil">${
          mudam.slice(0, 4).map((i) => `${esc(String(i.x_prod_original).slice(0, 34))} · ${esc(i.cfop_novo || '—')} → ${esc(cfop)}`).join('<br>')
        }${mudam.length > 4 ? `<br>e mais ${mudam.length - 4}…` : ''}</p>` : ''}`,
    });
    if (!ok) return;
  }

  if (alvos.length === 0) return alerta('Nenhum item na tela para aplicar.');

  // Uma requisicao por fatia de 200 (nao uma por item): antes a tela mandava os itens
  // em fila, sem aviso, e uma falha no meio parava o resto calada (audio de 23/09).
  const notaId = estado.notaAberta.nota.id;
  const FATIA = 200;
  let feitos = 0;
  mostrarEspera(`Aplicando ${cfop} em ${alvos.length} item(ns)…`);
  try {
    for (let k = 0; k < alvos.length; k += FATIA) {
      const fatia = alvos.slice(k, k + FATIA);
      await api(`/api/notas/${notaId}/aplicar-cfop`, {
        method: 'POST',
        body: JSON.stringify({ cfop, itens: fatia.map((i) => i.id), escopo }),
      });
      feitos += fatia.length;
      if (feitos < alvos.length) mostrarEspera(`Aplicando ${cfop}… ${feitos} de ${alvos.length}`);
    }
    avisarSalvo(`${cfop} aplicado em ${alvos.length} item(ns)`);
  } catch (e) {
    alerta(`Parou no meio: ${feitos} de ${alvos.length} item(ns) ficaram com ${cfop}. ` +
      `Nada se perdeu — clique de novo para terminar. (${e.message})`);
  } finally {
    esconderEspera();
    await recarregarNota().catch(() => {});
  }
}

// ------------------------------------------------------------------ procurar

/**
 * Achar o que foi tratado errado (audios da Taís, 23/09): "só sei que o produto é
 * energético, não sei a nota". Procura em todas as notas da empresa; "Últimas
 * alterações" mostra o que mudou por último, pela trilha. Os dois abrem a nota já na
 * linha do produto.
 */
function situacaoDoItem(it) {
  if (it.cancelada_em) return '<span class="tag dan">nota cancelada</span>';
  return it.revisado
    ? `<span class="tag ok">✓ conferido</span>${it.revisado_por_nome ? `<span class="porque">${esc(it.revisado_por_nome)} · ${esc(dataCurta(it.revisado_em))}</span>` : ''}`
    : '<span class="tag warn">a revisar</span>';
}

function tabelaDeItensAchados(itens, titulo) {
  if (!itens.length) return `<div class="vazio">${titulo} — nada encontrado.</div>`;
  return `<div class="rel-notas-caixa"><div class="rel-notas-topo"><b>${titulo}</b>
      <button class="btn sm sutil" type="button" data-fechar-busca>fechar</button></div>
    <div class="scroll"><table><thead><tr><th>Emissão</th><th>Nota</th><th>Fornecedor</th><th>Produto</th>
      <th>CFOP saída → entrada</th><th class="num">Valor</th><th>Situação</th><th></th></tr></thead>
    <tbody>${itens.map((it) => `<tr>
      <td class="tiny">${esc(dataCurta(it.dh_emi))}</td>
      <td class="mono">${esc(it.numero)}</td>
      <td>${esc(it.emit_nome ?? it.emit_cnpj)}<span class="porque">${esc(it.emit_cnpj ?? '')}</span></td>
      <td>${esc(it.x_prod_novo || it.x_prod_original)}${it.x_prod_novo && it.x_prod_novo !== it.x_prod_original
        ? `<span class="porque">na nota: ${esc(it.x_prod_original)}</span>` : ''}<span class="porque">cód. ${esc(it.c_prod ?? '—')} · item ${it.n_item}</span></td>
      <td class="mono">${esc(it.cfop_original ?? '—')} → <b>${esc(it.cfop_novo || '—')}</b></td>
      <td class="num">${moeda(it.valor_total)}</td>
      <td>${situacaoDoItem(it)}</td>
      <td><button class="btn sm" type="button" data-abrir-item="${esc(it.nota_id)}" data-item="${esc(it.item_id)}">Abrir →</button></td>
    </tr>`).join('')}</tbody></table></div></div>`;
}

$('#form-busca-itens')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const q = $('#busca-itens').value.trim();
  const caixa = $('#resultado-busca');
  if (q.length < 2) return alerta('Digite pelo menos 2 letras do produto (ou o código, o NCM, o número da nota).');
  if (!estado.empresaId) return;
  caixa.classList.remove('hidden');
  caixa.innerHTML = '<div class="vazio">procurando…</div>';
  try {
    const r = await api(`/api/empresas/${estado.empresaId}/busca-itens?q=${encodeURIComponent(q)}`);
    const mais = r.itens.length >= r.limite ? ` (mostrando os ${r.limite} mais recentes — refine a busca)` : '';
    caixa.innerHTML = tabelaDeItensAchados(r.itens, `${r.itens.length} item(ns) com “${esc(q)}”${mais}`);
  } catch (e) {
    caixa.innerHTML = `<div class="vazio">Não consegui procurar: ${esc(e.message)}</div>`;
  }
});

$('#btn-ultimas')?.addEventListener('click', async () => {
  const caixa = $('#resultado-busca');
  if (!estado.empresaId) return;
  caixa.classList.remove('hidden');
  caixa.innerHTML = '<div class="vazio">carregando…</div>';
  try {
    const r = await api(`/api/empresas/${estado.empresaId}/ultimas-alteracoes?limite=50`);
    if (!r.alteracoes.length) { caixa.innerHTML = '<div class="vazio">Nenhuma alteração ainda nesta empresa.</div>'; return; }
    caixa.innerHTML = `<div class="rel-notas-caixa"><div class="rel-notas-topo"><b>Últimas ${r.alteracoes.length} alterações nos itens desta empresa</b>
        <span class="tiny">mais recente primeiro</span>
        <button class="btn sm sutil" type="button" data-fechar-busca>fechar</button></div>
      <div class="scroll"><table><thead><tr><th>Quando</th><th>Quem</th><th>Nota</th><th>Produto</th><th>O que mudou</th><th></th></tr></thead>
      <tbody>${r.alteracoes.map((a) => `<tr>
        <td class="tiny">${esc(dataCurta(a.quando))} ${esc(String(a.quando ?? '').slice(11, 16))}</td>
        <td class="tiny">${esc(a.usuario_email ?? '—')}</td>
        <td class="mono">${esc(a.numero)}<span class="porque">${esc(a.emit_nome ?? '')}</span></td>
        <td>${esc(a.x_prod_novo || a.x_prod_original)}<span class="porque">cód. ${esc(a.c_prod ?? '—')} · item ${a.n_item}</span></td>
        <td>${esc(ROTULO_CAMPO[a.campo] ?? a.campo)}: ${a.valor_antes ? `<s>${esc(a.valor_antes)}</s> → ` : ''}<b>${esc(a.valor_depois ?? '—')}</b></td>
        <td><button class="btn sm" type="button" data-abrir-item="${esc(a.nota_id)}" data-item="${esc(a.item_id)}">Abrir →</button></td>
      </tr>`).join('')}</tbody></table></div></div>`;
  } catch (e) {
    caixa.innerHTML = `<div class="vazio">Não consegui listar: ${esc(e.message)}</div>`;
  }
});

document.addEventListener('click', (ev) => {
  const ab = ev.target.closest('[data-abrir-item]');
  if (ab) return abrirNota(ab.dataset.abrirItem, ab.dataset.item);
  if (ev.target.closest('[data-fechar-busca]')) {
    const caixa = ev.target.closest('#resultado-busca, tr.rel-notas');
    if (caixa?.id === 'resultado-busca') { caixa.classList.add('hidden'); caixa.innerHTML = ''; }
    else if (caixa) { caixa.previousElementSibling?.querySelector('.seta') && (caixa.previousElementSibling.querySelector('.seta').textContent = '▸'); caixa.remove(); }
  }
});

// ------------------------------------------------------------------ espera

/**
 * "Aguarde" que ocupa a tela enquanto uma acao em lote roda: gira, diz o que esta
 * fazendo e impede clique duplo. Pedido de 23/09 ("animacao de carregando ate que
 * finalize"). Quem prefere menos movimento ve so o texto.
 */
function mostrarEspera(texto) {
  let el = $('#espera');
  if (!el) {
    el = document.createElement('div');
    el.id = 'espera';
    el.className = 'espera';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<div class="espera-caixa"><span class="espera-roda" aria-hidden="true"></span><span class="espera-texto"></span></div>';
    document.body.appendChild(el);
  }
  el.querySelector('.espera-texto').textContent = texto;
  el.classList.remove('hidden');
}

function esconderEspera() {
  $('#espera')?.classList.add('hidden');
}

// ------------------------------------------------------------------ nota cancelada

$('#btn-cancelada')?.addEventListener('click', async () => {
  const n = estado.notaAberta;
  if (!n) return;
  const cancelar = !n.nota.cancelada_em;
  const ok = await confirmar({
    titulo: cancelar ? 'Marcar nota como cancelada' : 'Desfazer cancelamento',
    ok: cancelar ? 'Marcar como cancelada' : 'Desfazer',
    perigo: cancelar,
    corpo: cancelar
      ? `<p class="dialogo-texto">A NF <b>${esc(n.nota.numero)}</b> continua na lista, com a chave, mas passa a valer <b>zero</b>:</p>
         <ul class="dialogo-lista"><li>sai da soma de "Notas recebidas" e dos relatórios</li>
         <li>não entra no XML corrigido</li><li>fica registrado quem marcou — e dá para desfazer</li></ul>`
      : `<p class="dialogo-texto">A NF <b>${esc(n.nota.numero)}</b> volta a contar nas somas e nos relatórios.</p>`,
  });
  if (!ok) return;
  try {
    await api(`/api/notas/${n.nota.id}/cancelada`, { method: 'POST', body: JSON.stringify({ cancelada: cancelar }) });
    avisarSalvo(cancelar ? 'Nota marcada como cancelada' : 'Cancelamento desfeito');
    await recarregarNota();
    await carregarNotas();
  } catch (e) {
    alerta(e.message);
  }
});

// ------------------------------------------------------------------ ambiente 3

// ------------------------------------------------------------------ XML corrigido
//
// A pagina era um beco: pelo menu ela abria vazia ("Selecione uma nota") e nao
// oferecia jeito nenhum de escolher a nota dali; a "previa" era um resumo montado
// na tela, nao o arquivo; e nao havia exportacao em lote - com 77 notas numa
// competencia, baixar uma a uma nao e entrega. Agora:
//   - abre SEMPRE preenchida, com as notas da competencia e a situacao de cada uma;
//   - "Ver" mostra o XML corrigido DE VERDADE (o mesmo que sera baixado), com o que mudou;
//   - um .zip com todas as notas 100% conferidas. Nota com item nao conferido fica
//     de fora de proposito: palpite do sistema nao entra no Questor como decisao.

const xc = { competencia: '', filtro: 'todas', notas: [], notaId: null };

const situacaoXc = (n) =>
  n.itens_sem_cfop > 0 ? { k: 'bloqueada', txt: `▲ ${n.itens_sem_cfop} item(ns) sem CFOP`, cls: 'selo-bloqueado', ic: '▲' }
  : n.itens_revisados >= n.total_itens && n.total_itens > 0 ? { k: 'pronta', txt: 'pronta para exportar', cls: 'selo-conferido', ic: '✓' }
  : { k: 'pendente', txt: `${n.itens_revisados} de ${n.total_itens} itens conferidos`, cls: 'selo-conferir', ic: '●' };

async function abrirXmlCorrigido() {
  if (!estado.empresaId) return;
  if (estado.competencias.length === 0) await carregarCompetencias();
  const comps = estado.competencias.map((c) => c.competencia);
  // Se ha nota aberta no Tratamento, a pagina abre na competencia dela e ja mostra o XML dela.
  const daNota = estado.notaAberta?.nota?.competencia;
  if (daNota && comps.includes(daNota)) xc.competencia = daNota;
  if (!comps.includes(xc.competencia)) xc.competencia = comps.includes(estado.competencia) ? estado.competencia : (comps[0] ?? '');
  const sel = $('#xc-competencia');
  sel.innerHTML = comps.length
    ? comps.map((c) => `<option value="${c}">${MESES[Number(c.slice(5)) - 1] ?? c.slice(5)} de ${c.slice(0, 4)}</option>`).join('')
    : '<option value="">nenhuma nota importada</option>';
  sel.value = xc.competencia;
  await carregarListaXc();
  if (estado.notaAberta && xc.notas.some((n) => n.id === estado.notaAberta.nota.id)) {
    await verXmlCorrigido(estado.notaAberta.nota.id);
  } else {
    $('#xc-detalhe').classList.add('hidden');
    xc.notaId = null;
  }
}

async function carregarListaXc() {
  const corpo = $('#tbl-xc tbody');
  if (!xc.competencia) {
    xc.notas = [];
    corpo.innerHTML = '<tr><td colspan="6" class="vazio">Importe notas desta empresa para gerar XML corrigido.</td></tr>';
    $('#xc-resumo').textContent = '';
    return;
  }
  corpo.innerHTML = '<tr><td colspan="6" class="vazio">carregando…</td></tr>';
  try {
    xc.notas = await api(`/api/empresas/${estado.empresaId}/notas?competencia=${xc.competencia}`);
  } catch (e) {
    corpo.innerHTML = `<tr><td colspan="6" class="vazio">Não consegui listar as notas: ${esc(e.message)}</td></tr>`;
    return;
  }
  renderListaXc();
}

function renderListaXc() {
  const corpo = $('#tbl-xc tbody');
  const com = xc.notas.map((n) => ({ n, s: situacaoXc(n) }));
  const prontas = com.filter((x) => x.s.k === 'pronta').length;
  $('#xc-resumo').textContent =
    `${prontas} de ${xc.notas.length} nota(s) prontas para exportar — entram no .zip só as que têm todos os itens conferidos.`;
  $('#xc-baixar-zip').disabled = prontas === 0;

  const lista = com.filter((x) => xc.filtro === 'todas' || (xc.filtro === 'prontas' ? x.s.k === 'pronta' : x.s.k !== 'pronta'));
  if (lista.length === 0) {
    corpo.innerHTML = `<tr><td colspan="6" class="vazio">${
      xc.filtro === 'prontas' ? 'Nenhuma nota com todos os itens conferidos ainda.' : 'Nenhuma nota pendente neste mês.'}
      <button class="btn sm" id="xc-ver-todas">Ver todas as ${xc.notas.length} notas</button></td></tr>`;
    $('#xc-ver-todas')?.addEventListener('click', () => definirFiltroXc('todas'));
    return;
  }
  corpo.innerHTML = lista.map(({ n, s }) => `<tr class="${n.id === xc.notaId ? 'nota-andando' : ''}">
    <td class="tiny">${esc(dataCurta(n.dh_emi))}</td>
    <td class="mono">${esc(n.numero ?? '—')}</td>
    <td>${esc(n.emit_nome ?? n.emit_cnpj)}</td>
    <td class="num">${n.total_itens}</td>
    <td><span class="selo ${s.cls}"><span class="ic">${s.ic}</span>${esc(s.txt)}</span></td>
    <td style="text-align:right;white-space:nowrap">
      <button class="btn sm" data-xc-ver="${n.id}">Ver XML</button>
      ${s.k === 'pendente' || s.k === 'bloqueada' ? `<button class="btn sm sutil" data-xc-tratar="${n.id}">Tratar →</button>` : ''}
    </td></tr>`).join('');
}

function definirFiltroXc(f) {
  xc.filtro = f;
  $$('#xc-filtro button').forEach((b) => b.classList.toggle('on', b.dataset.xc === f));
  renderListaXc();
}

async function verXmlCorrigido(notaId) {
  xc.notaId = notaId;
  renderListaXc();
  const det = $('#xc-detalhe');
  det.classList.remove('hidden');
  const pre = $('#previa-xml');
  pre.textContent = 'gerando o XML corrigido…';
  let r;
  try {
    r = await api(`/api/notas/${notaId}/xml-corrigido/previa`);
  } catch (e) {
    pre.textContent = 'Não consegui gerar o XML corrigido: ' + e.message;
    return;
  }
  $('#xc-titulo').textContent = `Validações — NF ${r.numero}`;
  $('#lista-validacoes').innerHTML =
    linhaCheck(r.semCfop === 0, r.semCfop === 0 ? 'Todos os itens têm CFOP de entrada' : `${r.semCfop} item(ns) sem CFOP de entrada — exportação bloqueada`) +
    linhaCheck(r.conferidos === r.itens, `${r.conferidos} de ${r.itens} itens conferidos${r.conferidos < r.itens ? ' — só entra no .zip com todos conferidos' : ''}`) +
    r.invariantes.map((i) => linhaCheck(i.ok, i.nome + (i.detalhe ? ` (${i.detalhe})` : ''))).join('');

  $('#xc-hint-mudancas').textContent = r.alteracoes.length
    ? `${r.alteracoes.length} alteração(ões) — nada além disto muda no arquivo`
    : 'nenhuma alteração: o corrigido sai idêntico ao original';
  $('#tbl-xc-mudancas tbody').innerHTML = r.alteracoes.length
    ? r.alteracoes.map((a) => `<tr><td class="num tiny">${a.nItem}</td>
        <td>${a.campo === 'CFOP' ? 'CFOP' : 'Descrição'}</td>
        <td class="mono tiny"><s>${esc(a.antes)}</s></td><td class="mono"><b>${esc(a.depois)}</b></td></tr>`).join('')
    : '<tr><td colspan="4" class="vazio">Nenhum CFOP ou descrição foi alterado nesta nota.</td></tr>';

  // O arquivo de verdade, indentado; em destaque so as tags que de fato mudaram.
  let texto = indentarXml(r.xml)
    .replace(/(<(?:X509Certificate|SignatureValue)>)[^<]{80,}(<\/)/g, '$1… (recolhido — está íntegro no arquivo) …$2');
  let html = esc(texto);
  const mudou = new Map();
  for (const a of r.alteracoes) mudou.set(`${a.nItem}|${a.campo}`, a);
  let itemAtual = 0;
  html = html.split('\n').map((l) => {
    const d = l.match(/&lt;det\b[^&]*nItem=&quot;(\d+)&quot;/);
    if (d) itemAtual = Number(d[1]);
    const t = l.match(/^(\s*)&lt;(CFOP|xProd)&gt;(.*)&lt;\/\2&gt;$/);
    const a = t && mudou.get(`${itemAtual}|${t[2]}`);
    return a ? `${t[1]}&lt;${t[2]}&gt;<mark>${t[3]}</mark>&lt;/${t[2]}&gt;   <span class="xml-antes">era: ${esc(a.antes)}</span>` : l;
  }).join('\n');
  pre.innerHTML = html;
  det.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#xc-competencia').addEventListener('change', async (e) => {
  xc.competencia = e.target.value; xc.notaId = null;
  $('#xc-detalhe').classList.add('hidden');
  await carregarListaXc();
});
$$('#xc-filtro button').forEach((b) => b.addEventListener('click', () => definirFiltroXc(b.dataset.xc)));
$('#xc-baixar-zip').addEventListener('click', () => {
  if (!estado.empresaId || !xc.competencia) return alerta('Escolha uma empresa e um mês.');
  baixar(`/api/empresas/${estado.empresaId}/xml-corrigidos.zip?competencia=${xc.competencia}`);
});
document.addEventListener('click', (ev) => {
  const v = ev.target.closest('[data-xc-ver]');
  if (v) return verXmlCorrigido(v.dataset.xcVer);
  const t = ev.target.closest('[data-xc-tratar]');
  if (t) return abrirNota(t.dataset.xcTratar);
});

const linhaCheck = (ok, txt) =>
  `<li><span class="${ok ? 'ok' : 'fail'}">${ok ? '✓' : '✕'}</span> ${esc(txt)}</li>`;

$('#btn-baixar-xml').addEventListener('click', async () => {
  if (!xc.notaId) return alerta('Escolha uma nota na lista.');
  await baixar(`/api/notas/${xc.notaId}/xml-corrigido`);
});

$('#btn-baixar-csv').addEventListener('click', async () => {
  if (!xc.notaId) return alerta('Escolha uma nota na lista.');
  await baixar(`/api/notas/${xc.notaId}/escrituracao.csv`);
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
    <td><button class="link-tabela" data-abrir-empresa="${esc(e.id)}">${esc(e.razao_social)}</button></td>
    <td>${esc(e.uf ?? '—')}</td>
    <td><span class="tag info">${esc(e.perfil)}</span></td>
    <td class="mono tiny">${esc(e.cnae_principal ?? '—')}</td>
    <td class="acoes">
      ${pode('empresas.editar')
        ? `<button class="btn sm" data-abrir-empresa="${esc(e.id)}">Abrir</button>` : ''}
      ${pode('empresas.apagar')
        ? `<button class="btn sm perigo" data-apagar-empresa="${esc(e.id)}">Apagar</button>` : ''}
    </td>
  </tr>`).join('') || '<tr><td colspan="6" class="vazio">Nenhuma empresa cadastrada.</td></tr>';

  $$('#tbl-empresas button[data-apagar-empresa]').forEach((b) =>
    b.addEventListener('click', () => apagarEmpresa(b.dataset.apagarEmpresa)));

  $$('#tbl-empresas button[data-abrir-empresa]').forEach((b) =>
    b.addEventListener('click', () =>
      formularioEmpresa(estado.empresas.find((x) => x.id === b.dataset.abrirEmpresa))));
}

/**
 * Apagar empresa leva junto notas, itens, XMLs, regras e fornecedores dela.
 * Por isso pede o CNPJ digitado: é a diferença entre um clique errado e uma
 * decisão. O servidor confere de novo — a tela não é a guarda.
 */
function apagarEmpresa(id) {
  const e = estado.empresas.find((x) => x.id === id);
  abrirModal('Apagar cliente', `
    <p>Apagar <b>${esc(e?.razao_social ?? '')}</b> e <b>tudo</b> que pertence a ele:
      notas, itens, XMLs arquivados, regras aprendidas e fornecedores.</p>
    <p class="porque">Não dá para desfazer. Se a intenção é só parar de usar,
      desative o cliente em vez de apagar.</p>
    <label class="fl" style="margin-top:11px">Digite o CNPJ para confirmar</label>
    <input type="text" id="apagar-cnpj" placeholder="${esc(e?.cnpj ?? '')}" style="width:100%">
  `, async () => {
    const digitado = ($('#apagar-cnpj').value || '').replace(/\D/g, '');
    if (digitado !== (e?.cnpj ?? '')) throw new Error('o CNPJ digitado não confere');
    await api(`/api/empresas/${id}?confirmar=${digitado}`, { method: 'DELETE' });
    await carregarEmpresas();
    await carregarNotas();
  });
  $('#modal-ok').textContent = 'Apagar';
  $('#modal-ok').classList.add('perigo');
}

$('#btn-nova-empresa').addEventListener('click', () => formularioEmpresa(null));

/**
 * Cadastro de cliente — o mesmo formulário para criar e para corrigir.
 *
 * Faltava a parte de corrigir: a tela listava o cliente e só deixava apagar.
 * Quem errasse o perfil fiscal no cadastro tinha que apagar a empresa inteira,
 * com notas e regras junto, para cadastrar de novo. E as permissões
 * `empresas.editar` e `empresas.desativar` existiam sem caminho na tela.
 */
function formularioEmpresa(empresa) {
  const novo = !empresa;
  abrirModal(novo ? 'Nova empresa' : `Cliente: ${empresa.razao_social}`, `
    <div class="rowflex">
      <div style="flex:1"><label class="fl">CNPJ</label>
        <input type="text" id="e-cnpj" style="width:100%" value="${esc(empresa?.cnpj ?? '')}"
               ${novo ? '' : 'disabled title="O CNPJ identifica o cliente e as notas dele — não muda"'}></div>
      <div style="width:80px"><label class="fl">UF</label>
        <input type="text" id="e-uf" maxlength="2" style="width:100%" value="${esc(empresa?.uf ?? '')}"></div>
    </div>
    <div style="margin-top:11px"><label class="fl">Razão social</label>
      <input type="text" id="e-razao" style="width:100%" value="${esc(empresa?.razao_social ?? '')}"></div>
    <div style="margin-top:11px"><label class="fl">CNAE principal</label>
      <input type="text" id="e-cnae" placeholder="47.11-3/02" style="width:100%"
             value="${esc(empresa?.cnae_principal ?? '')}"></div>
    <div id="e-sugestao" class="aviso hidden"></div>
    <div style="margin-top:11px"><label class="fl">Perfil fiscal</label>
      <select id="e-perfil" style="width:100%">
        ${[['revenda', 'Comércio — revenda'],
           ['industrializacao', 'Indústria — insumo'],
           ['uso_consumo', 'Uso e consumo / serviços']]
          .map(([v, r]) => `<option value="${v}" ${empresa?.perfil === v ? 'selected' : ''}>${r}</option>`)
          .join('')}
      </select></div>
    <p class="tiny" style="margin-top:10px">O perfil define o CFOP sugerido enquanto o produto
      não tem padrão próprio. A partir da primeira nota tratada, o aprendizado passa por cima disso.</p>
  `, async () => {
    const cnpj = $('#e-cnpj').value.replace(/\D/g, '');
    if (novo && cnpj.length !== 14) throw new Error('CNPJ precisa ter 14 dígitos');
    if ($('#e-razao').value.trim().length < 2) throw new Error('informe a razão social');

    if (novo) {
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
    } else {
      // O CNPJ fica de fora de propósito: ele é a identidade do cliente e das
      // notas dele. Trocar o CNPJ é outro cliente, não uma correção.
      await api(`/api/empresas/${empresa.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          razao_social: $('#e-razao').value.trim(),
          uf: $('#e-uf').value.toUpperCase() || null,
          perfil: $('#e-perfil').value,
          cnae_principal: $('#e-cnae').value.trim() || null,
        }),
      });
      avisarSalvo('Cliente atualizado');
    }
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
}

/* ---------------------------------------------------------------- administração
 *
 * Duas telas: quem entra (Usuários) e o que cada conjunto de gente pode (Papéis).
 * O papel resolve quase tudo; a exceção por pessoa existe porque o resto é gente.
 */

let catalogoPermissoes = null;   // { grupo: [{chave, descricao, podeConceder}] }
let papeisCache = [];

async function catalogo() {
  if (!catalogoPermissoes) catalogoPermissoes = await api('/api/permissoes');
  return catalogoPermissoes;
}

/**
 * Monta as caixinhas agrupadas por tela.
 * `excecoes` é um Map permissao -> true/false, usado só na tela de usuário:
 * ali a caixinha mostra o que o PAPEL dá, e a marcação do usuário por cima.
 */
function montarCaixinhas(grupos, marcadas, { doPapel = null, prefixo = 'perm' } = {}) {
  return Object.entries(grupos).map(([grupo, itens]) => `
    <div class="perm-grupo">
      <h4>${esc(grupo)}</h4>
      ${itens.map((it) => {
        const herdada = doPapel ? doPapel.has(it.chave) : false;
        const marcada = marcadas.has(it.chave);
        let classe = '';
        if (doPapel) {
          if (marcada && !herdada) classe = 'excecao-mais';
          else if (!marcada && herdada) classe = 'excecao-menos';
        }
        if (!it.podeConceder) classe += ' bloqueada';
        return `
        <label class="perm-item ${classe}">
          <input type="checkbox" data-perm="${esc(it.chave)}" id="${prefixo}-${esc(it.chave)}"
            ${marcada ? 'checked' : ''} ${it.podeConceder ? '' : 'disabled'}>
          <span>${esc(it.descricao)}
            ${doPapel && herdada ? '<span class="d">— vem do papel</span>' : ''}
            ${it.podeConceder ? '' : '<span class="d">— você não tem esta permissão</span>'}
          </span>
        </label>`;
      }).join('')}
    </div>`).join('');
}

const permsMarcadas = () =>
  [...$$('#modal-corpo input[data-perm]')].filter((i) => i.checked).map((i) => i.dataset.perm);

/* ----------------------------------------------------------------- papéis */

async function carregarPapeis() {
  papeisCache = await api('/api/papeis');
  const podeEditar = estado.eu.permissoes.includes('papeis.gerenciar');
  $('#tbl-papeis tbody').innerHTML = papeisCache.map((p) => `<tr>
    <td><b>${esc(p.nome)}</b>${p.sistema ? ' <span class="d">(sistema)</span>' : ''}</td>
    <td>${esc(p.descricao ?? '')}</td>
    <td class="num">${p.n_permissoes}</td>
    <td class="num">${p.n_usuarios}</td>
    <td>${podeEditar && !p.sistema
      ? `<button class="btn sm" data-papel="${esc(p.id)}">Editar</button>`
      : '<span class="d">—</span>'}</td>
  </tr>`).join('') || '<tr><td colspan="5" class="vazio">Nenhum papel.</td></tr>';

  for (const b of $$('#tbl-papeis button[data-papel]')) {
    b.addEventListener('click', () => editarPapel(papeisCache.find((x) => x.id === b.dataset.papel)));
  }
}

async function editarPapel(papel) {
  const grupos = await catalogo();
  const marcadas = new Set(papel ? papel.permissoes : []);
  abrirModal(papel ? `Papel: ${papel.nome}` : 'Novo papel', `
    <div class="campo">
      <label class="fl" for="pp-nome">Nome</label>
      <input type="text" id="pp-nome" maxlength="40" value="${esc(papel?.nome ?? '')}"
             placeholder="Fiscal Jr, Só leitura, Estagiário...">
    </div>
    <div class="campo">
      <label class="fl" for="pp-desc">Para que serve</label>
      <input type="text" id="pp-desc" maxlength="200" value="${esc(papel?.descricao ?? '')}">
    </div>
    <p class="page-desc">Marque o que este papel pode fazer. O que estiver esmaecido é
      permissão que <b>você</b> não tem — ninguém concede o que não possui.</p>
    ${montarCaixinhas(grupos, marcadas, { prefixo: 'pp' })}
  `, async () => {
    const corpo = {
      nome: $('#pp-nome').value.trim(),
      descricao: $('#pp-desc').value.trim() || null,
      permissoes: permsMarcadas(),
    };
    if (corpo.nome.length < 2) throw new Error('dê um nome ao papel');
    await api(papel ? `/api/papeis/${papel.id}` : '/api/papeis', {
      method: papel ? 'PUT' : 'POST', body: JSON.stringify(corpo),
    });
    await carregarPapeis();
  });
}

$('#btn-novo-papel').addEventListener('click', () => editarPapel(null).catch((e) => alerta(e.message)));

/* --------------------------------------------------------------- usuários */

/**
 * Convites em aberto, e o botão de revogar.
 *
 * A tela gerava o link e esquecia dele. Um convite de Admin que vaze — grupo
 * errado do WhatsApp, e-mail reencaminhado — valia até vencer sozinho, sem
 * como cortar. Gerar sem revogar é meia funcionalidade.
 *
 * O código nunca aparece aqui: o banco guarda só o hash. Convite perdido se
 * gera de novo, não se recupera.
 */
async function carregarConvites() {
  const card = $('#card-convites');
  if (!card) return;
  if (!pode('usuarios.convidar')) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');

  const cs = await api('/api/convites');
  const abertos = cs.filter((c) => !c.revogado && !c.vencido && c.usos < c.usos_max);
  const situacao = (c) =>
    c.revogado ? '<span class="tag dan">revogado</span>'
    : c.vencido ? '<span class="tag mut">vencido</span>'
    : c.usos >= c.usos_max ? '<span class="tag mut">todo usado</span>'
    : '<span class="tag ok">válido</span>';

  $('#tbl-convites tbody').innerHTML = cs.map((c) => `<tr${c.revogado || c.vencido ? ' style="opacity:.55"' : ''}>
    <td>${esc(c.papel ?? '—')}</td>
    <td class="mono tiny">${c.usos} de ${c.usos_max}</td>
    <td class="tiny">${dataCurta(c.expira_em)}</td>
    <td>${situacao(c)}</td>
    <td class="acoes">${abertos.includes(c)
      ? `<button class="btn sm perigo" data-revogar="${esc(c.id)}">Revogar</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="5" class="vazio">Nenhum convite gerado.</td></tr>';

  $$('#tbl-convites button[data-revogar]').forEach((b) =>
    b.addEventListener('click', async () => {
      const ok = await confirmar({
        titulo: 'Revogar convite',
        ok: 'Revogar',
        perigo: true,
        corpo: '<p class="dialogo-texto">Quem tiver o link para de conseguir entrar por ele.</p>',
      });
      if (!ok) return;
      try {
        await api(`/api/convites/${b.dataset.revogar}`, { method: 'DELETE' });
        avisarSalvo('Convite revogado');
        await carregarConvites();
      } catch (e) { alerta(e.message); }
    }));
}

async function carregarUsuarios() {
  const us = await api('/api/usuarios');
  carregarConvites().catch(() => {});
  const podeEditar = estado.eu.permissoes.includes('usuarios.editar');
  const podeDesativar = estado.eu.permissoes.includes('usuarios.desativar');
  const podeSenha = estado.eu.permissoes.includes('usuarios.redefinir_senha');
  const podeMfa = estado.eu.permissoes.includes('usuarios.desativar_mfa');

  const podeAprovar = estado.eu.permissoes.includes('usuarios.aprovar');
  const pendentes = us.filter((u) => u.pendente).length;
  const pediramSenha = us.filter((u) => u.pediuSenha).length;
  const avisos = [];
  if (pendentes) {
    avisos.push(pendentes === 1
      ? '1 pessoa pediu acesso e está esperando liberação.'
      : `${pendentes} pessoas pediram acesso e estão esperando liberação.`);
  }
  if (pediramSenha) {
    avisos.push(pediramSenha === 1
      ? '1 pessoa esqueceu a senha e está esperando uma provisória.'
      : `${pediramSenha} pessoas esqueceram a senha e estão esperando uma provisória.`);
  }
  $('#aviso-pendentes').classList.toggle('hidden', avisos.length === 0);
  $('#aviso-pendentes').textContent = avisos.join(' ');

  $('#tbl-usuarios tbody').innerHTML = us.map((u) => `<tr${u.pendente || u.pediuSenha ? ' class="linha-pendente"' : (u.ativo ? '' : ' style="opacity:.55"')}>
    <td><b>${esc(u.nome)}</b></td>
    <td>${esc(u.email)}</td>
    <td>${esc(u.papel ?? '—')}</td>
    <td>${u.excecoes > 0 ? `${u.excecoes} ajuste(s)` : '<span class="d">—</span>'}</td>
    <td>${u.mfa ? '✓ ligado' : '<span class="d">não</span>'}</td>
    <td>${u.ultimo_login ? new Date(u.ultimo_login).toLocaleDateString('pt-BR') : '<span class="d">nunca</span>'}</td>
    <td>${u.pendente ? '<b>esperando liberação</b>'
      : u.pediuSenha ? '<b>esqueceu a senha</b>'
      : (u.ativo ? 'ativo' : 'desativado')}${u.deveTrocarSenha ? ' <span class="d">(senha provisória)</span>' : ''}</td>
    <td style="white-space:nowrap">
      ${u.pendente && podeAprovar ? `<button class="btn primary sm" data-aprovar="${esc(u.id)}">Liberar</button>
        <button class="btn sm" data-recusar="${esc(u.id)}">Recusar</button>` : ''}
      ${!u.pendente && podeEditar ? `<button class="btn sm" data-editar="${esc(u.id)}">Editar</button>` : ''}
      ${!u.pendente && podeSenha ? `<button class="btn ${u.pediuSenha ? 'primary ' : ''}sm" data-senha="${esc(u.id)}">Senha</button>` : ''}
      ${!u.pendente && podeDesativar ? `<button class="btn sm" data-ativo="${esc(u.id)}" data-para="${u.ativo ? '0' : '1'}">${u.ativo ? 'Desativar' : 'Reativar'}</button>` : ''}
      ${!u.pendente && u.mfa && podeMfa ? `<button class="btn sm" data-mfa="${esc(u.id)}"
        title="Para quem trocou de celular e ficou trancado para fora">Desligar 2º fator</button>` : ''}
    </td>
  </tr>`).join('') || '<tr><td colspan="8" class="vazio">Nenhum usuário.</td></tr>';

  for (const b of $$('#tbl-usuarios button[data-editar]')) {
    b.addEventListener('click', () => editarUsuario(b.dataset.editar).catch((e) => alerta(e.message)));
  }
  for (const b of $$('#tbl-usuarios button[data-aprovar]')) {
    b.addEventListener('click', () => aprovarPedido(b.dataset.aprovar).catch((e) => alerta(e.message)));
  }
  for (const b of $$('#tbl-usuarios button[data-recusar]')) {
    b.addEventListener('click', async () => {
      const ok = await confirmar({
        titulo: 'Recusar pedido de acesso',
        ok: 'Recusar',
        perigo: true,
        corpo: '<p class="dialogo-texto">A conta é apagada. A pessoa pode pedir acesso de novo.</p>',
      });
      if (!ok) return;
      try {
        await api(`/api/usuarios/${b.dataset.recusar}/recusar`, { method: 'POST' });
        await carregarUsuarios();
      } catch (e) { alerta(e.message); }
    });
  }
  // Trocar de celular sem desligar o segundo fator antes tranca a pessoa para
  // fora, e não havia caminho nenhum para destravar — a permissão existia, o
  // botão não.
  for (const b of $$('#tbl-usuarios button[data-mfa]')) {
    b.addEventListener('click', async () => {
      const ok = await confirmar({
        titulo: 'Desligar o segundo fator',
        ok: 'Desligar',
        perigo: true,
        corpo: `
          <p class="dialogo-texto">Ela volta a entrar só com e-mail e senha.</p>
          <p class="dialogo-texto sutil">Use quando a pessoa trocou de celular e ficou trancada
          para fora. Ela precisa configurar o segundo fator de novo depois.</p>`,
      });
      if (!ok) return;
      try {
        await api(`/api/usuarios/${b.dataset.mfa}/desativar-mfa`, { method: 'POST' });
        await carregarUsuarios();
      } catch (e) { alerta(e.message); }
    });
  }

  for (const b of $$('#tbl-usuarios button[data-senha]')) {
    b.addEventListener('click', () => redefinirSenhaDe(b.dataset.senha).catch((e) => alerta(e.message)));
  }
  for (const b of $$('#tbl-usuarios button[data-ativo]')) {
    b.addEventListener('click', async () => {
      const ativar = b.dataset.para === '1';
      const ok = await confirmar({
        titulo: ativar ? 'Reativar usuário' : 'Desativar usuário',
        ok: ativar ? 'Reativar' : 'Desativar',
        perigo: !ativar,
        corpo: ativar
          ? '<p class="dialogo-texto">A pessoa volta a conseguir entrar.</p>'
          : '<p class="dialogo-texto">As sessões dela caem na hora, em todos os aparelhos.</p>',
      });
      if (!ok) return;
      try {
        await api(`/api/usuarios/${b.dataset.ativo}/ativo`, {
          method: 'POST', body: JSON.stringify({ ativo: ativar }),
        });
        await carregarUsuarios();
      } catch (e) { alerta(e.message); }
    });
  }
}

async function editarUsuario(id) {
  const grupos = await catalogo();
  if (!papeisCache.length) papeisCache = await api('/api/papeis');
  const u = id ? await api(`/api/usuarios/${id}`) : null;
  const empresas = estado.empresas ?? [];

  const papelSelecionado = () => papeisCache.find((p) => p.id === $('#us-papel').value);

  abrirModal(u ? `Usuário: ${u.nome}` : 'Novo usuário', `
    <div class="campo">
      <label class="fl" for="us-nome">Nome</label>
      <input type="text" id="us-nome" value="${esc(u?.nome ?? '')}">
    </div>
    <div class="campo">
      <label class="fl" for="us-email">E-mail</label>
      <input type="email" id="us-email" value="${esc(u?.email ?? '')}" ${u ? 'disabled' : ''}>
      ${u ? '<span class="d">o e-mail identifica a conta e não muda</span>' : ''}
    </div>
    <div class="campo">
      <label class="fl" for="us-papel">Papel</label>
      <select id="us-papel">
        ${papeisCache.map((p) => `<option value="${esc(p.id)}" ${u?.papelId === p.id ? 'selected' : ''}>${esc(p.nome)}</option>`).join('')}
      </select>
    </div>
    <div class="campo">
      <label class="fl">Clientes que esta pessoa enxerga</label>
      ${empresas.length === 0 ? '<span class="d">nenhuma empresa cadastrada ainda</span>'
        : empresas.map((e) => `
        <label class="perm-item">
          <input type="checkbox" data-empresa="${esc(e.id)}" ${u?.empresas?.includes(e.id) ? 'checked' : ''}>
          <span>${esc(e.razao_social)}</span>
        </label>`).join('')}
      <p class="page-desc">Nenhum marcado: a pessoa só vê tudo se o papel dela tiver
        “ver TODOS os clientes”. Senão, não vê nada — e isso é proposital.</p>
    </div>
    <h3 style="margin:1rem 0 .4rem;font-size:.9rem">Ajustes só para esta pessoa</h3>
    <p class="page-desc">Verde = a mais do que o papel dá. Vermelho = tirado do papel.
      Se estiver mexendo muito aqui, provavelmente falta um papel novo.</p>
    <div id="us-perms"></div>
  `, async () => {
    const corpo = {
      nome: $('#us-nome').value.trim(),
      papelId: $('#us-papel').value,
      empresas: [...$$('#modal-corpo input[data-empresa]')].filter((i) => i.checked).map((i) => i.dataset.empresa),
      excecoes: [],
    };
    // A exceção é a DIFERENÇA entre o que está marcado e o que o papel dá.
    // Guardar a lista inteira faria a pessoa parar de acompanhar mudanças no
    // papel dela — que é justamente o motivo de o papel existir.
    const doPapel = new Set(papelSelecionado()?.permissoes ?? []);
    for (const i of $$('#modal-corpo input[data-perm]')) {
      const p = i.dataset.perm;
      if (i.checked && !doPapel.has(p)) corpo.excecoes.push({ permissao: p, concedida: true });
      if (!i.checked && doPapel.has(p)) corpo.excecoes.push({ permissao: p, concedida: false });
    }
    if (corpo.nome.length < 2) throw new Error('informe o nome');

    if (u) {
      await api(`/api/usuarios/${u.id}`, { method: 'PUT', body: JSON.stringify(corpo) });
      alerta('Salvo. As sessões desta pessoa foram encerradas para a mudança valer agora.');
    } else {
      corpo.email = $('#us-email').value.trim();
      const r = await api('/api/usuarios', { method: 'POST', body: JSON.stringify(corpo) });
      mostrarSenhaProvisoria(r.email, r.senhaProvisoria);
    }
    await carregarUsuarios();
  });

  // Redesenha as caixinhas quando o papel muda: o efeito de trocar de papel
  // tem de ser visível ANTES de salvar.
  const desenhar = () => {
    const doPapel = new Set(papelSelecionado()?.permissoes ?? []);
    const marcadas = new Set(doPapel);
    for (const e of (u?.excecoes ?? [])) {
      if (e.concedida) marcadas.add(e.permissao); else marcadas.delete(e.permissao);
    }
    $('#us-perms').innerHTML = montarCaixinhas(grupos, marcadas, { doPapel, prefixo: 'us' });
  };
  desenhar();
  $('#us-papel').addEventListener('change', desenhar);
}

/**
 * Liberar um pedido é a mesma decisão de criar um usuário — quem entra e com que
 * poder — então a tela é a mesma: papel, clientes e ajustes. A diferença é que a
 * senha já existe: quem se cadastrou escolheu a dela.
 */
async function aprovarPedido(id) {
  const grupos = await catalogo();
  if (!papeisCache.length) papeisCache = await api('/api/papeis');
  const u = await api(`/api/usuarios/${id}`);
  const empresas = estado.empresas ?? [];
  const papelSelecionado = () => papeisCache.find((p) => p.id === $('#ap-papel').value);

  abrirModal(`Liberar acesso de ${u.nome}`, `
    <p class="page-desc"><b>${esc(u.email)}</b> pediu acesso e escolheu a própria senha.
      Defina o papel e o que ela enxerga.</p>
    <div class="campo">
      <label class="fl" for="ap-papel">Papel</label>
      <select id="ap-papel">
        ${papeisCache.map((p) => `<option value="${esc(p.id)}">${esc(p.nome)}</option>`).join('')}
      </select>
    </div>
    <div class="campo">
      <label class="fl">Clientes que esta pessoa enxerga</label>
      ${empresas.length === 0 ? '<span class="d">nenhuma empresa cadastrada ainda</span>'
        : empresas.map((e) => `
        <label class="perm-item">
          <input type="checkbox" data-empresa="${esc(e.id)}"><span>${esc(e.razao_social)}</span>
        </label>`).join('')}
    </div>
    <h3 style="margin:1rem 0 .4rem;font-size:.9rem">Ajustes só para esta pessoa</h3>
    <div id="ap-perms"></div>
  `, async () => {
    const doPapel = new Set(papelSelecionado()?.permissoes ?? []);
    const excecoes = [];
    for (const i of $$('#modal-corpo input[data-perm]')) {
      const p = i.dataset.perm;
      if (i.checked && !doPapel.has(p)) excecoes.push({ permissao: p, concedida: true });
      if (!i.checked && doPapel.has(p)) excecoes.push({ permissao: p, concedida: false });
    }
    await api(`/api/usuarios/${id}/aprovar`, {
      method: 'POST',
      body: JSON.stringify({
        papelId: $('#ap-papel').value,
        empresas: [...$$('#modal-corpo input[data-empresa]')].filter((i) => i.checked).map((i) => i.dataset.empresa),
        excecoes,
      }),
    });
    await carregarUsuarios();
  });
  $('#modal-ok').textContent = 'Liberar';

  const desenhar = () => {
    const doPapel = new Set(papelSelecionado()?.permissoes ?? []);
    $('#ap-perms').innerHTML = montarCaixinhas(grupos, new Set(doPapel), { doPapel, prefixo: 'ap' });
  };
  desenhar();
  $('#ap-papel').addEventListener('change', desenhar);
}

function mostrarSenhaProvisoria(email, senha) {
  setTimeout(() => {
    abrirModal('Usuário criado', `
      <p class="page-desc">Passe esta senha para <b>${esc(email)}</b>. Ela é provisória:
        a pessoa é obrigada a trocá-la no primeiro acesso, e a partir daí nem você
        sabe qual é.</p>
      <div class="senha-provisoria">${esc(senha)}</div>
      <p class="page-desc"><b>Não aparece de novo.</b> Se perder, use o botão “Senha”
        na lista para gerar outra.</p>
    `, async () => {});
    $('#modal-cancelar').classList.add('hidden');
    $('#modal-ok').textContent = 'Copiei';
  }, 30);
}

async function redefinirSenhaDe(id) {
  const u = await api(`/api/usuarios/${id}`);
  abrirModal(`Redefinir a senha de ${u.nome}`, `
    <p class="page-desc">A pessoa vai receber uma senha provisória e será obrigada a
      trocá-la no primeiro acesso. As sessões dela caem agora.</p>
    <div class="campo">
      <label class="fl" for="rs-nova">Senha provisória</label>
      <input type="text" id="rs-nova" value="${esc(gerarSenhaProvisoria())}">
      <span class="d">pode editar; mínimo 12 caracteres</span>
    </div>
    <div class="campo">
      <label class="fl" for="rs-minha">Confirme a SUA senha</label>
      <input type="password" id="rs-minha" autocomplete="current-password">
      <span class="d">redefinir a senha de outra pessoa dá acesso à conta dela</span>
    </div>
  `, async () => {
    await api(`/api/usuarios/${id}/redefinir-senha`, {
      method: 'POST',
      body: JSON.stringify({
        senhaProvisoria: $('#rs-nova').value, minhaSenha: $('#rs-minha').value,
      }),
    });
    const senha = $('#rs-nova').value;
    mostrarSenhaProvisoria(u.email, senha);
    await carregarUsuarios();
  });
}

function gerarSenhaProvisoria() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(14))].map((b) => A[b % A.length]).join('');
}

async function gerarConvite() {
  if (!papeisCache.length) papeisCache = await api('/api/papeis');
  abrirModal('Gerar convite', `
    <p class="page-desc">Quem abrir este link entra <b>na hora</b>, já com o papel escolhido —
      ninguém precisa aprovar. Mande no grupo do escritório.</p>
    <div class="campo">
      <label class="fl" for="cv-papel">Papel de quem entrar</label>
      <select id="cv-papel">
        ${papeisCache.map((p) => `<option value="${esc(p.id)}">${esc(p.nome)}</option>`).join('')}
      </select>
    </div>
    <div class="rowflex">
      <div style="flex:1"><label class="fl" for="cv-usos">Quantas pessoas podem usar</label>
        <input type="number" id="cv-usos" value="3" min="1" max="50" style="width:100%"></div>
      <div style="flex:1"><label class="fl" for="cv-horas">Vale por (horas)</label>
        <input type="number" id="cv-horas" value="72" min="1" max="720" style="width:100%"></div>
    </div>
    <p class="page-desc">O prazo e o limite de usos existem para o link não virar porta
      permanente. Se sobrar convite sem usar, ele vence sozinho.</p>
  `, async () => {
    const r = await api('/api/convites', {
      method: 'POST',
      body: JSON.stringify({
        papelId: $('#cv-papel').value,
        usos: Number($('#cv-usos').value),
        horas: Number($('#cv-horas').value),
      }),
    });
    mostrarConvite(r);
  });
  $('#modal-ok').textContent = 'Gerar';
}

function mostrarConvite(r) {
  carregarConvites().catch(() => {});
  const link = `${location.origin}/?convite=${encodeURIComponent(r.codigo)}`;
  setTimeout(() => {
    abrirModal('Convite gerado', `
      <p class="page-desc">Mande este link para até <b>${r.usos} pessoa(s)</b>. Quem abrir
        entra como <b>${esc(r.papel)}</b>, sem passar por aprovação. Vale ${r.horas} horas.</p>
      <div class="senha-provisoria" style="font-size:.9rem">${esc(link)}</div>
      <p class="page-desc">Se preferir passar só o código: <b>${esc(r.codigo)}</b></p>
      <p class="page-desc"><b>Não aparece de novo</b> — no banco fica só o embaralhado dele.
        Convite perdido se gera outro.</p>
    `, async () => {});
    $('#modal-cancelar').classList.add('hidden');
    $('#modal-ok').textContent = 'Copiei';
  }, 30);
}

$('#btn-convidar').addEventListener('click', () => gerarConvite().catch((e) => alerta(e.message)));

$('#btn-novo-usuario').addEventListener('click', () => editarUsuario(null).catch((e) => alerta(e.message)));

// ------------------------------------------------------------------ fornecedores e regras

// ------------------------------------------------------------------ relatorios
//
// Por CFOP e por produto, por empresa e competencia. Pedido da contadora para
// bater o tratamento dela com o da colega no fim do mes - e o instrumento de
// medicao do projeto. A conta e do servidor; a tela so desenha, e a planilha
// baixada sai da MESMA rota (formato=csv), para tela e arquivo nunca discordarem.

const rel = { qual: 'cfop', competencia: '' };

async function abrirRelatorios() {
  if (!estado.empresaId) return;
  if (estado.competencias.length === 0) await carregarCompetencias();
  const sel = $('#rel-competencia');
  // As opcoes vem do universo inteiro de competencias, nunca de um resultado filtrado.
  const comps = estado.competencias.map((c) => c.competencia);
  if (!comps.includes(rel.competencia)) {
    rel.competencia = comps.includes(estado.competencia) ? estado.competencia : (comps[0] ?? '');
  }
  sel.innerHTML = comps.length
    ? comps.map((c) => `<option value="${c}">${MESES[Number(c.slice(5)) - 1] ?? c.slice(5)} de ${c.slice(0, 4)}</option>`).join('')
    : '<option value="">nenhuma nota importada</option>';
  sel.value = rel.competencia;
  await carregarRelatorio();
}

async function carregarRelatorio() {
  const tabela = $('#tbl-relatorio');
  const aviso = $('#rel-aviso');
  const [cab, corpo, pe] = [tabela.querySelector('thead'), tabela.querySelector('tbody'), tabela.querySelector('tfoot')];
  if (!estado.empresaId || !rel.competencia) {
    cab.innerHTML = pe.innerHTML = '';
    corpo.innerHTML = '<tr><td class="vazio">Importe notas desta empresa para ver os relatórios.</td></tr>';
    aviso.classList.add('hidden');
    return;
  }
  corpo.innerHTML = '<tr><td class="vazio">calculando…</td></tr>';
  let r;
  try {
    r = await api(`/api/empresas/${estado.empresaId}/relatorios/${rel.qual}?competencia=${rel.competencia}`);
  } catch (e) {
    cab.innerHTML = pe.innerHTML = '';
    corpo.innerHTML = `<tr><td class="vazio">Não consegui montar o relatório: ${esc(e.message)}</td></tr>`;
    return;
  }

  // O relatorio inclui o que ainda nao foi conferido - e diz isso, para o total
  // bater com o do outro sistema sem fazer palpite passar por decisao.
  const pendentes = r.totais.itens - r.totais.conferidos;
  const canceladas = Number(r.canceladas ?? 0);
  aviso.classList.toggle('hidden', pendentes === 0 && canceladas === 0);
  aviso.textContent = [
    pendentes > 0 ? `⚠ ${pendentes} de ${r.totais.itens} itens ainda não foram conferidos — entram aqui com o valor sugerido pelo sistema.` : '',
    canceladas > 0 ? `⊘ ${canceladas} nota(s) cancelada(s) fora do relatório.` : '',
  ].filter(Boolean).join(' ');

  const qtd = (v) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 4 });
  if (rel.qual === 'cfop') {
    // Sintetico no formato do livro de entradas; clicar na linha abre as notas
    // daquele CFOP (analitico). Pedido da Tais, 22/09: "so um CFOP fechou (...)
    // eu nao consigo procurar a minha diferenca".
    cab.innerHTML = '<tr><th>CFOP de entrada</th><th>Natureza</th><th class="num">Notas</th><th class="num">Itens</th><th class="num">Conferidos</th><th class="num">Valor contábil</th><th class="num">Base ICMS</th><th class="num">ICMS</th><th class="num">ICMS ST</th><th class="num">IPI</th><th>CFOP original (itens)</th></tr>';
    corpo.innerHTML = r.linhas.map((l) => `<tr class="rel-cfop" data-rel-cfop="${esc(l.cfop)}" title="Clique para ver as notas deste CFOP">
      <td class="mono"><span class="seta">▸</span> <b>${esc(l.cfop)}</b></td><td>${esc(l.natureza)}</td>
      <td class="num">${l.notas}</td><td class="num">${l.itens}</td><td class="num">${l.conferidos}</td>
      <td class="num"><b>${moeda(l.valorContabil)}</b></td><td class="num">${moeda(l.baseIcms)}</td><td class="num">${moeda(l.icms)}</td>
      <td class="num">${moeda(l.st)}</td><td class="num">${moeda(l.ipi)}</td><td class="tiny">${esc(l.origem)}</td></tr>`).join('');
    const t = r.totais;
    pe.innerHTML = `<tr><th>Total</th><th></th><th class="num">${t.notas}</th><th class="num">${t.itens}</th><th class="num">${t.conferidos}</th><th class="num">${moeda(t.valorContabil)}</th><th class="num">${moeda(t.baseIcms)}</th><th class="num">${moeda(t.icms)}</th><th class="num">${moeda(t.st)}</th><th class="num">${moeda(t.ipi)}</th><th></th></tr>`;
  } else {
    cab.innerHTML = '<tr><th>Produto</th><th>Un.</th><th class="num">Quantidade</th><th class="num">Unitário médio</th><th class="num">Valor total</th><th>CFOP</th><th>Cód. fornecedor</th><th class="num">Notas</th></tr>';
    corpo.innerHTML = r.linhas.map((l) => `<tr class="rel-cfop" data-rel-produto="${esc(l.descricao)}" data-rel-unidade="${esc(l.unidade)}" title="Clique para ver as notas deste produto">
      <td><span class="seta">▸</span> ${esc(l.descricao)}${l.descricaoOriginal && l.descricaoOriginal !== l.descricao
        ? `<span class="porque">na nota: ${esc(l.descricaoOriginal)}</span>` : ''}</td>
      <td class="tiny">${esc(l.unidade)}</td>
      <td class="num">${qtd(l.quantidade)}</td>
      <td class="num">${l.valorUnitarioMedio === null ? '—' : Number(l.valorUnitarioMedio).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
      <td class="num">${moeda(l.valor)}</td>
      <td class="mono tiny">${esc(l.cfops)}</td><td class="mono tiny">${esc(l.codigos)}</td>
      <td class="num">${l.notas}</td></tr>`).join('');
    pe.innerHTML = `<tr><th>Total · ${r.linhas.length} produtos</th><th></th><th></th><th></th><th class="num">${moeda(r.totais.valor)}</th><th></th><th></th><th></th></tr>`;
  }
  if (r.linhas.length === 0) {
    corpo.innerHTML = '<tr><td class="vazio" colspan="8">Nenhum item nesta competência.</td></tr>';
  }
}

$$('#rel-qual button').forEach((b) => b.addEventListener('click', () => {
  rel.qual = b.dataset.rel;
  $$('#rel-qual button').forEach((x) => x.classList.toggle('on', x === b));
  carregarRelatorio();
}));
$('#rel-competencia').addEventListener('change', (e) => { rel.competencia = e.target.value; carregarRelatorio(); });
// Abre/fecha as notas de um CFOP logo abaixo da linha dele.
$('#tbl-relatorio').addEventListener('click', async (ev) => {
  const abrir = ev.target.closest('button[data-abrir-nota-rel]');
  if (abrir) return abrirNota(abrir.dataset.abrirNotaRel);
  const baixarCfop = ev.target.closest('button[data-baixar-cfop]');
  if (baixarCfop) {
    return baixar(`/api/empresas/${estado.empresaId}/relatorios/analitico?competencia=${rel.competencia}&cfop=${encodeURIComponent(baixarCfop.dataset.baixarCfop)}&formato=csv`);
  }
  const linhaProduto = ev.target.closest('tr[data-rel-produto]');
  if (linhaProduto) return abrirNotasDoProduto(linhaProduto);
  const linha = ev.target.closest('tr[data-rel-cfop]');
  if (!linha) return;
  const cfop = linha.dataset.relCfop;
  const aberto = linha.nextElementSibling?.classList.contains('rel-notas');
  if (aberto) { linha.nextElementSibling.remove(); linha.querySelector('.seta').textContent = '▸'; return; }
  linha.querySelector('.seta').textContent = '▾';
  const sub = document.createElement('tr');
  sub.className = 'rel-notas';
  sub.innerHTML = '<td colspan="11" class="vazio">carregando as notas…</td>';
  linha.after(sub);
  try {
    const r = await api(`/api/empresas/${estado.empresaId}/relatorios/notas?competencia=${rel.competencia}&cfop=${encodeURIComponent(cfop)}`);
    const soma = (k) => r.notas.reduce((s, n) => s + n[k], 0);
    sub.innerHTML = `<td colspan="11"><div class="rel-notas-caixa">
      <div class="rel-notas-topo"><b>${r.notas.length} nota(s) no CFOP ${esc(cfop)}</b>
        <span class="tiny">os valores somam só os itens deste CFOP; "Total da nota" é a nota inteira</span>
        <button class="btn sm" data-baixar-cfop="${esc(cfop)}">⇩ Analítico deste CFOP (item a item)</button></div>
      <table><thead><tr><th>Emissão</th><th>Número</th><th>Fornecedor</th><th class="num">Itens</th><th class="num">Valor contábil</th><th class="num">Base ICMS</th><th class="num">ICMS</th><th class="num">ICMS ST</th><th class="num">IPI</th><th class="num">Total da nota</th><th></th></tr></thead>
      <tbody>${r.notas.map((n) => `<tr>
        <td class="tiny">${esc(dataCurta(n.data))}</td><td class="mono">${esc(n.numero)}</td>
        <td>${esc(n.fornecedor)}<span class="porque">${esc(n.cnpj)}</span></td>
        <td class="num">${n.itens}${n.conferidos < n.itens ? `<span class="porque">${n.conferidos} conf.</span>` : ''}</td>
        <td class="num"><b>${moeda(n.valorContabil)}</b></td><td class="num">${moeda(n.baseIcms)}</td><td class="num">${moeda(n.icms)}</td>
        <td class="num">${moeda(n.st)}</td><td class="num">${moeda(n.ipi)}</td>
        <td class="num tiny">${moeda(n.valorNota)}${Math.abs(n.valorNota - n.valorContabil) > 0.009 ? '<span class="porque">tem itens em outro CFOP</span>' : ''}</td>
        <td><button class="btn sm" data-abrir-nota-rel="${esc(n.notaId)}">Abrir →</button></td></tr>`).join('')}</tbody>
      <tfoot><tr><th colspan="3">Total do CFOP ${esc(cfop)}</th><th class="num">${soma('itens')}</th><th class="num">${moeda(soma('valorContabil'))}</th><th class="num">${moeda(soma('baseIcms'))}</th><th class="num">${moeda(soma('icms'))}</th><th class="num">${moeda(soma('st'))}</th><th class="num">${moeda(soma('ipi'))}</th><th></th><th></th></tr></tfoot>
      </table></div></td>`;
  } catch (e) {
    sub.innerHTML = `<td colspan="11" class="vazio">Não consegui listar as notas: ${esc(e.message)}</td>`;
  }
});

/** Relatório por produto: clicar abre as notas em que ele aparece (23/09). */
async function abrirNotasDoProduto(linha) {
  const aberto = linha.nextElementSibling?.classList.contains('rel-notas');
  if (aberto) { linha.nextElementSibling.remove(); linha.querySelector('.seta').textContent = '▸'; return; }
  linha.querySelector('.seta').textContent = '▾';
  const sub = document.createElement('tr');
  sub.className = 'rel-notas';
  sub.innerHTML = '<td colspan="8" class="vazio">carregando as notas…</td>';
  linha.after(sub);
  try {
    const q = new URLSearchParams({ produto: linha.dataset.relProduto, unidade: linha.dataset.relUnidade, competencia: rel.competencia });
    const r = await api(`/api/empresas/${estado.empresaId}/busca-itens?${q}`);
    sub.innerHTML = `<td colspan="8">${tabelaDeItensAchados(r.itens, `${r.itens.length} item(ns) de ${esc(linha.dataset.relProduto)}`)}</td>`;
  } catch (e) {
    sub.innerHTML = `<td colspan="8" class="vazio">Não consegui listar: ${esc(e.message)}</td>`;
  }
}

$('#rel-baixar-analitico').addEventListener('click', () => {
  if (!estado.empresaId || !rel.competencia) return alerta('Escolha uma empresa com notas importadas.');
  baixar(`/api/empresas/${estado.empresaId}/relatorios/analitico?competencia=${rel.competencia}&formato=csv`);
});

$('#rel-baixar').addEventListener('click', () => {
  if (!estado.empresaId || !rel.competencia) return alerta('Escolha uma empresa com notas importadas.');
  baixar(`/api/empresas/${estado.empresaId}/relatorios/${rel.qual}?competencia=${rel.competencia}&formato=csv`);
});

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
/** Chamado quando o modal fecha SEM confirmar. Usado por confirmar(). */
let aoDesistir = null;

function abrirModal(titulo, html, aoSalvar) {
  $('#modal-titulo').textContent = titulo;
  $('#modal-corpo').innerHTML = html;
  acaoModal = aoSalvar;
  // Volta ao padrão antes de abrir. A tela de códigos de recuperação esconde o
  // Cancelar e troca o rótulo do botão; sem este reset, o próximo modal a abrir
  // herdaria isso e apareceria sem saída — bug que só se vê duas telas adiante.
  $('#modal-cancelar').classList.remove('hidden');
  $('#modal-ok').textContent = 'Salvar';
  $('#modal-ok').classList.remove('perigo');
  $('#modal-fundo').classList.remove('hidden');
}

function fecharModal() {
  $('#modal-fundo').classList.add('hidden');
  acaoModal = null;
  const desistiu = aoDesistir;
  aoDesistir = null;
  if (desistiu) desistiu();
}

$('#modal-cancelar').addEventListener('click', fecharModal);

// Esc fecha, como qualquer caixa de dialogo. Sem isto o unico jeito de sair e
// achar o botao, e a pessoa fica presa quando a janela esta pequena.
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$('#modal-fundo').classList.contains('hidden')) fecharModal();
});
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

/**
 * Caixas de dialogo da propria tela, no lugar das do navegador.
 *
 * `confirm()` e `alert()` nativos foram trocados por estes. O motivo nao e so
 * estetica, embora ela conte: a caixa do navegador escreve "fiscal.alfa-contabil.com
 * says" em cima do texto, ignora a tipografia do sistema, e o Chrome oferece
 * "impedir esta pagina de criar mais caixas" - se a pessoa marcar isso sem ler,
 * o `confirm` passa a devolver false calado e a acao simplesmente nao acontece,
 * sem nenhum aviso. Uma confirmacao que some em silencio e pior que nenhuma.
 *
 * E havia incoerencia: a tela ja tinha modal proprio (editar cliente, papeis),
 * e estas caixas passavam por fora dele.
 */
function confirmar({ titulo, corpo, ok = 'Confirmar', perigo = false }) {
  return new Promise((resolve) => {
    let decidiu = false;
    abrirModal(titulo, corpo, () => { decidiu = true; resolve(true); });
    aoDesistir = () => { if (!decidiu) resolve(false); };
    $('#modal-ok').textContent = ok;
    $('#modal-ok').classList.toggle('perigo', perigo);
    $('#modal-ok').focus();
  });
}

/** Aviso de uma informacao so, com um botao de fechar. */
function avisar(msg, titulo = 'Aviso') {
  return new Promise((resolve) => {
    abrirModal(titulo, `<p class="dialogo-texto">${esc(msg)}</p>`, () => resolve());
    aoDesistir = () => resolve();
    $('#modal-cancelar').classList.add('hidden');
    $('#modal-ok').textContent = 'Entendi';
    $('#modal-ok').focus();
  });
}

const alerta = avisar;

// ------------------------------------------------------------------ boot

(async () => {
  try { await iniciar(); } catch { mostrarLogin(); }
})();
