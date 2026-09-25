/**
 * DANFE para imprimir ou salvar em PDF, montado do XML original guardado.
 *
 * Pedido da reunião de 25/09: o cliente às vezes pede "o PDF da nota", e a
 * Taís tinha que entrar no site da SEFAZ para baixar. A tela "Nota original"
 * serve para conferir (tem as marcas do sistema); isto aqui é a nota limpa,
 * como o fornecedor emitiu, para mandar ao cliente.
 *
 * Sai como página HTML com a folha já formatada em A4. O navegador abre a
 * janela de impressão e ela escolhe "Salvar como PDF". Nada aqui vem do que
 * foi tratado no sistema — CFOP e descrição são os do fornecedor.
 */
import type { NotaOriginal } from './visao';
import { code128cSvg } from './codigo-barras';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const moeda = (v: number | null | undefined, casas = 2) =>
  v === null || v === undefined ? '' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: Math.max(casas, 4) });

const doc = (d: string | null) =>
  !d ? '' : d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
    : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : d;

/** Data/hora da NF-e ("2026-09-09T10:01:08-03:00") como está no XML, sem converter fuso. */
const dataBr = (iso: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}` : '';
};

const campo = (rotulo: string, valor: string, classe = '') =>
  `<div class="c ${classe}"><span class="r">${esc(rotulo)}</span><span class="v">${valor || '&nbsp;'}</span></div>`;

export function danfeHtml(n: NotaOriginal, opcoes: { cancelada?: boolean } = {}): string {
  const chave = n.chave ?? '';
  const chaveFmt = chave.replace(/(\d{4})(?=\d)/g, '$1 ');
  const barras = /^\d{44}$/.test(chave) ? code128cSvg(chave, 44, 1) : '';
  const e = n.emit;
  const d = n.dest;
  const t = n.totais;
  const tpNF = n.tipo === 'Entrada' ? '0' : n.tipo === 'Saída' ? '1' : '';

  const itens = n.itens.map((i) => `<tr>
    <td>${esc(i.cProd)}</td>
    <td class="desc">${esc(i.xProd)}${i.infAdProd ? `<div class="obs">${esc(i.infAdProd)}</div>` : ''}</td>
    <td>${esc(i.NCM)}</td><td>${esc(i.cst)}</td><td>${esc(i.CFOP)}</td><td>${esc(i.uCom)}</td>
    <td class="n">${moeda(i.qCom, 4)}</td><td class="n">${moeda(i.vUnCom, 4)}</td><td class="n">${moeda(i.vProd)}</td>
    <td class="n">${moeda(i.vBC)}</td><td class="n">${moeda(i.vICMS)}</td><td class="n">${moeda(i.vIPI)}</td>
    <td class="n">${moeda(i.pICMS)}</td><td class="n">${moeda(i.pIPI)}</td>
  </tr>`).join('');

  const titulo = `NF-e ${n.numero ?? ''} - ${e.nome ?? ''}`.trim();
  const adicionais = [n.infAdFisco, n.infCpl].filter(Boolean).join('\n\n');

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>${esc(titulo)}</title>
<style>
  @page { size: A4 portrait; margin: 8mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 9px/1.25 Arial, Helvetica, sans-serif; color: #000; background: #e9edf2; }
  .folha { width: 194mm; margin: 12px auto; background: #fff; padding: 0; position: relative; }
  .barra { width: 194mm; margin: 12px auto 0; display: flex; gap: 10px; align-items: center;
    font: 13px/1.4 Arial, sans-serif; color: #1c3b63; }
  .barra button { font: 600 13px Arial, sans-serif; padding: 7px 14px; border-radius: 6px; border: 1px solid #1c3b63;
    background: #1c3b63; color: #fff; cursor: pointer; }
  .linha { display: flex; }
  .c { border: 1px solid #000; margin: 0 -1px -1px 0; padding: 1px 3px; min-height: 22px; flex: 1; overflow: hidden; }
  .c .r { display: block; font-size: 6.5px; text-transform: uppercase; }
  .c .v { display: block; font-size: 9px; font-weight: bold; white-space: pre-wrap; word-break: break-word; }
  .c.dir .v { text-align: right; }
  .sec { font-size: 7.5px; font-weight: bold; text-transform: uppercase; margin: 5px 0 1px; }
  .topo { display: flex; }
  .emit { flex: 0 0 76mm; border: 1px solid #000; padding: 4px; margin: 0 -1px -1px 0; }
  .emit b { font-size: 11px; display: block; margin-bottom: 3px; }
  .danfe { flex: 0 0 34mm; border: 1px solid #000; padding: 4px; margin: 0 -1px -1px 0; text-align: center; }
  .danfe h1 { font-size: 15px; margin: 0; }
  .danfe .tp { display: inline-block; border: 1px solid #000; padding: 1px 6px; font-size: 13px; font-weight: bold; margin: 3px 0; }
  .chave { flex: 1; border: 1px solid #000; padding: 4px; margin: 0 -1px -1px 0; }
  .chave .num { font: bold 9.5px monospace; text-align: center; margin: 3px 0; letter-spacing: .3px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #000; padding: 1px 2px; font-size: 7.5px; vertical-align: top; }
  th { font-size: 6.5px; text-transform: uppercase; font-weight: bold; }
  td.n { text-align: right; white-space: nowrap; }
  td.desc { width: 34%; }
  .obs { font-size: 6.5px; color: #333; }
  .adic { border: 1px solid #000; min-height: 22mm; padding: 3px; white-space: pre-wrap; font-size: 7.5px; }
  .rodape { font-size: 6.5px; color: #444; margin-top: 4px; text-align: right; }
  .carimbo { position: absolute; top: 90mm; left: 0; right: 0; text-align: center; font: bold 64px Arial;
    color: rgba(190, 0, 0, .28); transform: rotate(-24deg); pointer-events: none; }
  @media print {
    body { background: #fff; }
    .barra { display: none; }
    .folha { margin: 0; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; }
  }
</style></head>
<body>
<div class="barra">
  <button type="button" onclick="window.print()">Salvar em PDF / imprimir</button>
  <span>Na janela que abrir, escolha <b>“Salvar como PDF”</b> como impressora.</span>
</div>
<div class="folha">
  ${opcoes.cancelada ? '<div class="carimbo">NOTA CANCELADA</div>' : ''}
  <div class="topo">
    <div class="emit">
      <b>${esc(e.nome)}</b>
      ${esc(e.endereco)}<br>${esc([e.municipio, e.uf].filter(Boolean).join(' - '))}
    </div>
    <div class="danfe">
      <h1>DANFE</h1>
      <div>Documento Auxiliar da<br>Nota Fiscal Eletrônica</div>
      <div>0 - Entrada<br>1 - Saída <span class="tp">${esc(tpNF)}</span></div>
      <div><b>Nº ${esc(n.numero)}</b><br><b>Série ${esc(n.serie)}</b></div>
    </div>
    <div class="chave">
      ${barras}
      <div class="r" style="font-size:6.5px;text-transform:uppercase">Chave de acesso</div>
      <div class="num">${esc(chaveFmt)}</div>
      <div style="text-align:center">Consulta de autenticidade no portal nacional da NF-e<br>www.nfe.fazenda.gov.br/portal ou no site da Sefaz autorizadora</div>
    </div>
  </div>
  <div class="linha">
    ${campo('Natureza da operação', esc(n.natOp))}
    ${campo('Protocolo de autorização de uso', esc([n.protocolo, dataBr(n.dhProtocolo)].filter(Boolean).join(' - ')))}
  </div>
  <div class="linha">
    ${campo('Inscrição estadual', esc(e.ie))}
    ${campo('CNPJ', esc(doc(e.doc)))}
  </div>

  <div class="sec">Destinatário / remetente</div>
  <div class="linha">
    ${campo('Nome / razão social', esc(d.nome), '')}
    ${campo('CNPJ / CPF', esc(doc(d.doc)))}
    ${campo('Data da emissão', esc(dataBr(n.dhEmi)))}
  </div>
  <div class="linha">
    ${campo('Endereço', esc(d.endereco))}
    ${campo('Município', esc(d.municipio))}
    ${campo('UF', esc(d.uf))}
    ${campo('Inscrição estadual', esc(d.ie))}
    ${campo('Data da saída/entrada', esc(dataBr(n.dhSaiEnt)))}
  </div>

  <div class="sec">Cálculo do imposto</div>
  <div class="linha">
    ${campo('Base de cálculo do ICMS', moeda(t['vBC']), 'dir')}
    ${campo('Valor do ICMS', moeda(t['vICMS']), 'dir')}
    ${campo('Base de cálculo ICMS ST', moeda(t['vBCST']), 'dir')}
    ${campo('Valor do ICMS ST', moeda(t['vST']), 'dir')}
    ${campo('Valor total dos produtos', moeda(t['vProd']), 'dir')}
  </div>
  <div class="linha">
    ${campo('Valor do frete', moeda(t['vFrete']), 'dir')}
    ${campo('Valor do seguro', moeda(t['vSeg']), 'dir')}
    ${campo('Desconto', moeda(t['vDesc']), 'dir')}
    ${campo('Outras despesas', moeda(t['vOutro']), 'dir')}
    ${campo('Valor do IPI', moeda(t['vIPI']), 'dir')}
    ${campo('Valor total da nota', moeda(t['vNF']), 'dir')}
  </div>

  <div class="sec">Dados dos produtos / serviços</div>
  <table>
    <thead><tr><th>Código</th><th>Descrição</th><th>NCM/SH</th><th>CST</th><th>CFOP</th><th>Un.</th><th>Quant.</th>
      <th>V. unit.</th><th>V. total</th><th>BC ICMS</th><th>V. ICMS</th><th>V. IPI</th><th>Alíq. ICMS</th><th>Alíq. IPI</th></tr></thead>
    <tbody>${itens}</tbody>
  </table>

  <div class="sec">Dados adicionais</div>
  <div class="adic">${esc(adicionais)}</div>
  <div class="rodape">Representação da NF-e gerada a partir do XML autorizado guardado no Alfa Fiscal, sem alteração.</div>
</div>
<script>window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 400); });</script>
</body></html>`;
}
