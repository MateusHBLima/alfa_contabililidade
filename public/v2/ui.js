/* Alfa Fiscal v2 — peças de tela: aviso rápido, diálogo de confirmação e menus. */

import { $, esc } from './util.js';

/* ---- Aviso rápido (canto de baixo): "Salvo", "3 itens conferidos", erros ---- */
let sumir = null;
export function aviso(texto, tipo = 'ok') {
  const el = $('#aviso');
  el.className = `aviso aviso-${tipo}`;
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(sumir);
  sumir = setTimeout(() => { el.hidden = true; }, tipo === 'erro' ? 6000 : 2400);
}

/** Erro de gravação: no modo teste, a mensagem diz que nada foi gravado. */
export function avisoErro(e, prefixo = '') {
  aviso(e?.modoTeste ? 'Tela nova em teste: aqui é só para olhar. Nada foi gravado.' : `${prefixo}${e?.message ?? e}`, e?.modoTeste ? 'teste' : 'erro');
}

/* ---- Diálogo: uma pergunta, um botão principal ---- */
export function confirmar({ titulo, corpo, ok = 'Confirmar', cancelar = 'Cancelar', perigo = false }) {
  return new Promise((resolve) => {
    const d = $('#dialogo');
    d.innerHTML = `<form method="dialog" class="dialogo-caixa">
        <h2>${esc(titulo)}</h2>
        <div class="dialogo-corpo">${corpo}</div>
        <footer>
          ${cancelar ? `<button type="button" class="btn" value="nao">${esc(cancelar)}</button>` : ''}
          <button type="submit" class="btn ${perigo ? 'perigo' : 'primario'}" value="sim">${esc(ok)}</button>
        </footer>
      </form>`;
    const fim = (v) => { d.close(); resolve(v); };
    d.querySelector('button[value="nao"]')?.addEventListener('click', () => fim(false));
    d.querySelector('form').addEventListener('submit', (ev) => { ev.preventDefault(); fim(true); });
    d.addEventListener('cancel', () => resolve(false), { once: true });
    d.showModal();
    d.querySelector('button[value="sim"]').focus();
  });
}

export const informar = (titulo, corpo) => confirmar({ titulo, corpo, ok: 'Fechar', cancelar: null });

/* ---- Menus que abrem embaixo de um botão (empresa, mês, "Mais") ---- */
let aberto = null;
export function abrirMenu(botao, html, aoEscolher, { largura } = {}) {
  fecharMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = html;
  if (largura) m.style.width = largura;
  document.body.append(m);
  const r = botao.getBoundingClientRect();
  const w = m.offsetWidth;
  m.style.top = `${r.bottom + 6 + window.scrollY}px`;
  m.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  botao.setAttribute('aria-expanded', 'true');
  m.addEventListener('click', (ev) => {
    const op = ev.target.closest('[data-op]');
    if (!op || op.disabled) return;
    fecharMenu();
    aoEscolher(op.dataset.op, op);
  });
  aberto = { m, botao };
  m.querySelector('input')?.focus();
  return m;
}
export function fecharMenu() {
  if (!aberto) return;
  aberto.botao.setAttribute('aria-expanded', 'false');
  aberto.m.remove();
  aberto = null;
}
document.addEventListener('mousedown', (ev) => {
  if (aberto && !aberto.m.contains(ev.target) && !aberto.botao.contains(ev.target)) fecharMenu();
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') fecharMenu(); });

/* ---- "Carregando…" discreto no topo ---- */
let ocupado = 0;
export async function comEspera(promessa) {
  ocupado += 1;
  $('#carregando').hidden = false;
  try { return await promessa; } finally {
    ocupado -= 1;
    if (ocupado === 0) $('#carregando').hidden = true;
  }
}
