import type { CustomsTerritory, ProcedureKind } from './customs';

/**
 * The customs workflow on a shipment: statuses of each procedure, who must be named for it, which
 * documents it needs, which service a provider offers for it, and whether the truck may go to the
 * border. These are planning rules, reviewed by a customs professional before launch; they never
 * replace the declarant's own legal checks.
 */
export const PROCEDURE_STATUSES = [
  'NOT_REQUIRED',
  'INFORMATION_MISSING',
  'DOCUMENTS_PENDING',
  'BROKER_ASSIGNED',
  'DECLARATION_PREPARING',
  'DECLARATION_SUBMITTED',
  'DECLARATION_ACCEPTED',
  'BORDER_ACTION_REQUIRED',
  'BORDER_HOLD',
  'RELEASED',
  'PROCEDURE_COMPLETED',
] as const;
export type ProcedureStatus = (typeof PROCEDURE_STATUSES)[number];

/** Statuses the system works out by itself from parties, documents and the provider. */
export const PREPARATION_STATUSES: ProcedureStatus[] = [
  'INFORMATION_MISSING',
  'DOCUMENTS_PENDING',
  'BROKER_ASSIGNED',
];

/** What the person handling the procedure may move it to, from each status. */
export const HANDLER_TRANSITIONS: Partial<Record<ProcedureStatus, ProcedureStatus[]>> = {
  BROKER_ASSIGNED: ['DECLARATION_PREPARING', 'DECLARATION_SUBMITTED'],
  DOCUMENTS_PENDING: ['DECLARATION_PREPARING'],
  DECLARATION_PREPARING: ['DECLARATION_SUBMITTED'],
  DECLARATION_SUBMITTED: [
    'DECLARATION_ACCEPTED',
    'BORDER_ACTION_REQUIRED',
    'DECLARATION_PREPARING',
  ],
  DECLARATION_ACCEPTED: [
    'RELEASED',
    'BORDER_ACTION_REQUIRED',
    'BORDER_HOLD',
    'PROCEDURE_COMPLETED',
  ],
  BORDER_ACTION_REQUIRED: [
    'DECLARATION_SUBMITTED',
    'DECLARATION_ACCEPTED',
    'BORDER_HOLD',
    'RELEASED',
  ],
  BORDER_HOLD: ['RELEASED', 'BORDER_ACTION_REQUIRED'],
  RELEASED: ['PROCEDURE_COMPLETED'],
};

export function statusRank(s: ProcedureStatus): number {
  return PROCEDURE_STATUSES.indexOf(s);
}

export const CUSTOMS_SERVICES = [
  'export_declaration',
  'import_declaration',
  'transit_declaration',
  'safety_security_filing',
  'gvms_reference',
  'fiscal_formalities',
  'classification',
  'origin_documents',
  'consultation',
] as const;
export type CustomsService = (typeof CUSTOMS_SERVICES)[number];

/** Services that need a provider to look at the case and quote, not a fixed price. */
export const QUOTE_SERVICES: CustomsService[] = [
  'classification',
  'origin_documents',
  'consultation',
];

export function serviceFor(kind: ProcedureKind): CustomsService | null {
  switch (kind) {
    case 'export':
      return 'export_declaration';
    case 'import':
      return 'import_declaration';
    case 'transit':
      return 'transit_declaration';
    case 'entry_safety_security':
      return 'safety_security_filing';
    case 'gb_gvms':
      return 'gvms_reference';
    case 'fiscal':
      return 'fiscal_formalities';
    default:
      return null;
  }
}

/** The country whose customs office handles it: exports and transits where the goods start, imports where they arrive. */
export function filingCountry(
  kind: ProcedureKind,
  territory: CustomsTerritory | null,
  pickupCountry: string,
  deliveryCountry: string,
): string {
  if (kind === 'export' || kind === 'transit') return pickupCountry;
  if (kind === 'gb_gvms') return 'GB';
  if (territory === 'XI') return 'GB';
  return deliveryCountry;
}

export const PARTY_ROLES = [
  'exporter',
  'importer_of_record',
  'export_declarant',
  'import_declarant',
  'customs_representative',
  'transit_principal',
  'carrier',
  'safety_security_filer',
  'movement_reference_party',
  'duty_payer',
  'import_vat_payer',
  'permits_party',
] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

/** Who must be named (and have confirmed) before a procedure can go ahead. */
export function requiredRoles(kind: ProcedureKind): PartyRole[] {
  switch (kind) {
    case 'export':
      return ['exporter', 'export_declarant'];
    case 'import':
      return ['importer_of_record', 'import_declarant', 'duty_payer', 'import_vat_payer'];
    case 'transit':
      return ['transit_principal'];
    case 'entry_safety_security':
      return ['safety_security_filer'];
    case 'gb_gvms':
      return ['movement_reference_party'];
    default:
      return [];
  }
}

export const DOCUMENT_TYPES = [
  'commercial_invoice',
  'proforma_invoice',
  'packing_list',
  'origin_proof',
  'export_licence',
  'certificate',
  'power_of_attorney',
  'transit_document',
  'cmr',
  'export_accompanying_document',
  'clearance_confirmation',
  'other',
] as const;
export type CustomsDocumentType = (typeof DOCUMENT_TYPES)[number];

/** Documents a procedure normally needs before the declaration can be made. */
export function requiredDocuments(kind: ProcedureKind): CustomsDocumentType[] {
  switch (kind) {
    case 'export':
    case 'import':
      return ['commercial_invoice', 'packing_list'];
    case 'transit':
      return ['commercial_invoice'];
    default:
      return [];
  }
}

export const REFERENCE_TYPES = ['MRN', 'LRN', 'GMR', 'ENS', 'EAD', 'T1', 'T2', 'other'] as const;

export interface ProcedureState {
  id: string;
  kind: ProcedureKind;
  status: ProcedureStatus;
  reference: string | null;
  referenceType: string | null;
}

/**
 * Before the truck goes to the border: every procedure needed to cross must be far enough. Exports,
 * transits, safety & security and GVMS references must be accepted (or later); an import must at
 * least be submitted (pre-lodged). Any hold blocks. This is a cautious planning rule; brokers may
 * know better for a specific border.
 */
export function borderReadiness(procs: ProcedureState[]): {
  required: boolean;
  ready: boolean;
  missing: Array<{
    procedureId: string;
    kind: ProcedureKind;
    reason: 'not_far_enough' | 'hold' | 'action_required' | 'no_reference';
  }>;
} {
  const relevant = procs.filter(
    (p) => p.status !== 'NOT_REQUIRED' && p.kind !== 'check_route' && p.kind !== 'fiscal',
  );
  const missing: Array<{
    procedureId: string;
    kind: ProcedureKind;
    reason: 'not_far_enough' | 'hold' | 'action_required' | 'no_reference';
  }> = [];
  for (const p of relevant) {
    if (p.status === 'BORDER_HOLD')
      missing.push({ procedureId: p.id, kind: p.kind, reason: 'hold' });
    else if (p.status === 'BORDER_ACTION_REQUIRED')
      missing.push({ procedureId: p.id, kind: p.kind, reason: 'action_required' });
    else {
      const needed: ProcedureStatus =
        p.kind === 'import' ? 'DECLARATION_SUBMITTED' : 'DECLARATION_ACCEPTED';
      if (statusRank(p.status) < statusRank(needed))
        missing.push({ procedureId: p.id, kind: p.kind, reason: 'not_far_enough' });
      else if (!p.reference)
        missing.push({ procedureId: p.id, kind: p.kind, reason: 'no_reference' });
    }
  }
  return { required: relevant.length > 0, ready: missing.length === 0, missing };
}
