import { describe, expect, it } from 'vitest';
import {
  cargoTotals,
  fitProblems,
  suitableClasses,
  VEHICLE_CLASS_BY_ID,
  type CargoLine,
} from './vehicles';

const pallet = (quantity: number, weightKg = 400, stackable = false): CargoLine => ({
  quantity,
  kind: 'eur_pallet',
  lengthCm: 120,
  widthCm: 80,
  heightCm: 120,
  weightKg,
  stackable,
});

describe('cargo totals', () => {
  it('counts EUR pallets as floor places and loading metres', () => {
    const t = cargoTotals([pallet(10)]);
    expect(t.palletPlaces).toBe(10);
    expect(t.weightKg).toBe(4_000);
    expect(t.loadingMetres).toBe(4); // 10 × 0.4 ldm
  });
  it('stacking halves the floor places when two layers fit', () => {
    expect(cargoTotals([pallet(10, 200, true)], 260).palletPlaces).toBe(5);
  });
});

describe('fit', () => {
  it('rejects cargo heavier than the payload', () => {
    const van = VEHICLE_CLASS_BY_ID.get('van_large')!;
    expect(fitProblems({ lines: [pallet(3, 500)] }, van).map((p) => p.code)).toContain('too_heavy');
  });
  it('rejects too many pallets even when the weight is fine', () => {
    const van = VEHICLE_CLASS_BY_ID.get('van_large')!;
    expect(fitProblems({ lines: [pallet(6, 50)] }, van).map((p) => p.code)).toContain(
      'too_many_pallets',
    );
  });
  it('needs a tail lift when asked for', () => {
    const rigid = VEHICLE_CLASS_BY_ID.get('rigid_truck')!;
    expect(fitProblems({ lines: [pallet(2)], needsTailLiftDelivery: true }, rigid)[0]?.code).toBe(
      'missing_equipment',
    );
  });
  it('needs refrigeration covering the range', () => {
    const reefer = VEHICLE_CLASS_BY_ID.get('refrigerated')!;
    expect(fitProblems({ lines: [pallet(2)], temperature: { minC: 2, maxC: 8 } }, reefer)).toEqual(
      [],
    );
    const box = VEHICLE_CLASS_BY_ID.get('box_truck')!;
    expect(
      fitProblems({ lines: [pallet(2)], temperature: { minC: 2, maxC: 8 } }, box)[0]?.code,
    ).toBe('temperature');
  });
  it('never fits dangerous goods (not enabled yet)', () => {
    expect(suitableClasses({ lines: [pallet(1)], dangerousGoods: true })).toEqual([]);
  });
  it('picks the smallest suitable class first', () => {
    expect(suitableClasses({ lines: [pallet(1, 300)] })[0]).toBe('van_light');
    expect(suitableClasses({ lines: [pallet(20, 500)] })[0]).toBe('curtainsider');
    expect(suitableClasses({ lines: [pallet(2)], temperature: { minC: 2, maxC: 8 } })).toEqual([
      'refrigerated',
    ]);
  });
});
