import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { resumirRespostaAdn, prestadorDoXml } from '../src/captura/adn';

/** 16/11: resumo da consulta na base nacional da NFS-e (ADN) pelo intermediário. */
const xml = (doc: string, tag: 'CNPJ' | 'CPF' = 'CNPJ') => `<NFSe><infNFSe><emit><${tag}>${doc}</${tag}><xNome>X</xNome></emit><DPS><infDPS><toma><CNPJ>99999999000199</CNPJ></toma></infDPS></DPS></infNFSe></NFSe>`;

describe('ADN da NFS-e: resumo da resposta', () => {
  it('conta os documentos, tira o prestador das primeiras notas e o maior NSU', async () => {
    const corpo = JSON.stringify({
      StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS',
      LoteDFe: [
        { NSU: 3, ArquivoXml: gzipSync(xml('11222333000181')).toString('base64') },
        { NSU: 12, ArquivoXml: gzipSync(xml('12345678909', 'CPF')).toString('base64') },
        { NSU: 7, ArquivoXml: Buffer.from(xml('44555666000199')).toString('base64') },
      ],
    });
    expect(await resumirRespostaAdn(200, '/contribuintes/DFe/0', corpo)).toEqual({
      status: 200, caminho: '/contribuintes/DFe/0', documentos: 3, maiorNsu: 12,
      prestadores: [{ nsu: '3', documento: '11222333000181' }, { nsu: '12', documento: '12345678909' }, { nsu: '7', documento: '44555666000199' }],
    });
  });

  it('sem a lista, devolve o código e o começo da resposta', async () => {
    const r = await resumirRespostaAdn(404, '/contribuinte/DFe/0', '{"erro":"rota inexistente"}');
    expect(r).toMatchObject({ status: 404, documentos: 0, maiorNsu: null, resposta: '{"erro":"rota inexistente"}' });
    expect((await resumirRespostaAdn(200, '/contribuintes/DFe/0', '{"StatusProcessamento":"NENHUM_DOCUMENTO_LOCALIZADO"}')).documentos).toBe(0);
  });

  it('o prestador é o do <emit> (ou <prest>), não o tomador', () => {
    expect(prestadorDoXml(xml('11222333000181'))).toBe('11222333000181');
    expect(prestadorDoXml('<DPS><prest><CPF>12345678909</CPF></prest></DPS>')).toBe('12345678909');
    expect(prestadorDoXml('<x/>')).toBe('(não achei no XML)');
  });
});
