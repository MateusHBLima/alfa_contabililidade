-- Regras de ICMS por CFOP de entrada (planilha da Taís, 25/09).
-- "manter" = base e ICMS como vieram no XML; "outras" = base e ICMS zerados e o
-- valor contábil inteiro na coluna Outras do relatório. A regra é aplicada na
-- hora de montar o relatório (não grava nada no item nem no XML): se ela trocar
-- o CFOP de um item depois, o relatório acompanha sozinho.
CREATE TABLE IF NOT EXISTS regras_icms (
  tenant_id      TEXT NOT NULL,
  cfop           TEXT NOT NULL,
  regra          TEXT NOT NULL CHECK (regra IN ('manter', 'outras')),
  atualizado_em  TEXT NOT NULL,
  atualizado_por TEXT,
  PRIMARY KEY (tenant_id, cfop)
);

-- Uma instrução por CFOP: o SQLite do D1 recusa SELECT composto com muitos termos.
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1102', 'manter', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '2102', 'manter', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1101', 'manter', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '2101', 'manter', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1556', 'manter', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '2556', 'manter', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1403', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '2403', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1407', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '2407', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1551', 'manter', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '2551', 'manter', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1202', 'manter', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '2202', 'manter', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1949', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '2949', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1411', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '2411', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1653', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1652', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1910', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '2910', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1117', 'manter', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '2117', 'manter', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1922', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '2922', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1916', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '2916', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '1912', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
INSERT OR IGNORE INTO regras_icms (tenant_id, cfop, regra, atualizado_em) SELECT id, '2912', 'outras', '2026-09-28T00:00:00.000Z' FROM tenants;
