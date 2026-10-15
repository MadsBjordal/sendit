import { describe, expect, it } from 'vitest';
import { borderReadiness, filingCountry, requiredRoles, serviceFor } from './customsWorkflow';

describe('customs workflow rules', () => {
  it('maps procedures to services and filing countries', () => {
    expect(serviceFor('export')).toBe('export_declaration');
    expect(serviceFor('check_route')).toBeNull();
    expect(filingCountry('export', 'EU', 'DE', 'NO')).toBe('DE');
    expect(filingCountry('import', 'NO', 'DE', 'NO')).toBe('NO');
    expect(filingCountry('import', 'XI', 'IE', 'GB')).toBe('GB');
  });
  it('names the roles each procedure needs', () => {
    expect(requiredRoles('import')).toContain('importer_of_record');
    expect(requiredRoles('export')).toEqual(['exporter', 'export_declarant']);
  });
  it('an accepted export does not make the border ready while the import is not submitted', () => {
    const r = borderReadiness([
      {
        id: 'e',
        kind: 'export',
        status: 'DECLARATION_ACCEPTED',
        reference: 'MRN1',
        referenceType: 'MRN',
      },
      {
        id: 'i',
        kind: 'import',
        status: 'DOCUMENTS_PENDING',
        reference: null,
        referenceType: null,
      },
    ]);
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual([{ procedureId: 'i', kind: 'import', reason: 'not_far_enough' }]);
  });
  it('is ready with an accepted export and a pre-lodged import, and blocked by a hold', () => {
    const procs = [
      {
        id: 'e',
        kind: 'export' as const,
        status: 'DECLARATION_ACCEPTED' as const,
        reference: 'MRN1',
        referenceType: 'MRN',
      },
      {
        id: 'i',
        kind: 'import' as const,
        status: 'DECLARATION_SUBMITTED' as const,
        reference: 'NO-1',
        referenceType: 'MRN',
      },
    ];
    expect(borderReadiness(procs).ready).toBe(true);
    expect(
      borderReadiness([{ ...procs[0]!, status: 'BORDER_HOLD' }, procs[1]!]).missing[0]!.reason,
    ).toBe('hold');
  });
  it('needs a reference, and ignores procedures that are not required', () => {
    expect(
      borderReadiness([
        {
          id: 'e',
          kind: 'export',
          status: 'DECLARATION_ACCEPTED',
          reference: null,
          referenceType: null,
        },
      ]).missing[0]!.reason,
    ).toBe('no_reference');
    expect(
      borderReadiness([
        { id: 'x', kind: 'export', status: 'NOT_REQUIRED', reference: null, referenceType: null },
      ]),
    ).toEqual({ required: false, ready: true, missing: [] });
  });
});
