/**
 * Vehicle classes and the physical fit of cargo in a vehicle.
 * A class gives typical numbers for estimating; matching always uses the carrier's own
 * vehicle numbers (payload, cargo space), never only the class name.
 */
export type VehicleClass =
  | 'van_light'
  | 'van_large'
  | 'box_truck'
  | 'rigid_truck'
  | 'curtainsider'
  | 'articulated'
  | 'refrigerated'
  | 'flatbed'
  | 'specialist';

export type Equipment =
  'tail_lift' | 'refrigeration' | 'side_loading' | 'top_loading' | 'pallet_jack' | 'adr';

export interface CargoSpace {
  payloadKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  /** EUR pallet places (120 × 80 cm) on the floor */
  palletPlaces: number;
  equipment: Equipment[];
  /** For refrigerated vehicles: the range it can hold, °C */
  tempMinC?: number | null;
  tempMaxC?: number | null;
}

export interface VehicleClassInfo extends CargoSpace {
  class: VehicleClass;
  /** Smaller rank = smaller, cheaper vehicle. Used to pick the vehicle for an estimate. */
  rank: number;
  /** Offered for automatic booking at launch. Specialist work needs review first. */
  bookable: boolean;
}

export const VEHICLE_CLASSES: VehicleClassInfo[] = [
  {
    class: 'van_light',
    rank: 1,
    bookable: true,
    payloadKg: 800,
    lengthCm: 250,
    widthCm: 160,
    heightCm: 140,
    palletPlaces: 2,
    equipment: [],
  },
  {
    class: 'van_large',
    rank: 2,
    bookable: true,
    payloadKg: 1200,
    lengthCm: 420,
    widthCm: 175,
    heightCm: 190,
    palletPlaces: 4,
    equipment: [],
  },
  {
    class: 'box_truck',
    rank: 3,
    bookable: true,
    payloadKg: 3000,
    lengthCm: 600,
    widthCm: 240,
    heightCm: 230,
    palletPlaces: 12,
    equipment: ['tail_lift'],
  },
  {
    class: 'rigid_truck',
    rank: 4,
    bookable: true,
    payloadKg: 9000,
    lengthCm: 750,
    widthCm: 245,
    heightCm: 260,
    palletPlaces: 18,
    equipment: [],
  },
  {
    class: 'curtainsider',
    rank: 5,
    bookable: true,
    payloadKg: 24000,
    lengthCm: 1360,
    widthCm: 245,
    heightCm: 270,
    palletPlaces: 33,
    equipment: ['side_loading', 'top_loading'],
  },
  {
    class: 'articulated',
    rank: 6,
    bookable: true,
    payloadKg: 24000,
    lengthCm: 1360,
    widthCm: 245,
    heightCm: 270,
    palletPlaces: 33,
    equipment: [],
  },
  {
    class: 'refrigerated',
    rank: 7,
    bookable: true,
    payloadKg: 22000,
    lengthCm: 1330,
    widthCm: 245,
    heightCm: 260,
    palletPlaces: 33,
    equipment: ['refrigeration'],
    tempMinC: -25,
    tempMaxC: 25,
  },
  {
    class: 'flatbed',
    rank: 8,
    bookable: false,
    payloadKg: 24000,
    lengthCm: 1360,
    widthCm: 245,
    heightCm: 300,
    palletPlaces: 33,
    equipment: ['side_loading', 'top_loading'],
  },
  {
    class: 'specialist',
    rank: 9,
    bookable: false,
    payloadKg: 40000,
    lengthCm: 1600,
    widthCm: 300,
    heightCm: 400,
    palletPlaces: 40,
    equipment: [],
  },
];

export const VEHICLE_CLASS_BY_ID = new Map(VEHICLE_CLASSES.map((v) => [v.class, v]));

export interface CargoLine {
  description?: string | null;
  /** Number of handling units (pallets or packages) */
  quantity: number;
  kind: 'eur_pallet' | 'industrial_pallet' | 'package' | 'other';
  /** Per unit, cm */
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  /** Per unit, kg */
  weightKg: number;
  stackable: boolean;
}

export interface CargoRequirements {
  lines: CargoLine[];
  needsTailLiftPickup?: boolean;
  needsTailLiftDelivery?: boolean;
  temperature?: { minC: number; maxC: number } | null;
  dangerousGoods?: boolean;
}

export interface CargoTotals {
  units: number;
  weightKg: number;
  volumeM3: number;
  /** Floor positions in EUR-pallet equivalents, after stacking */
  palletPlaces: number;
  loadingMetres: number;
  longestCm: number;
  tallestCm: number;
}

const PALLET_AREA_CM2 = 120 * 80;
const TRUCK_WIDTH_CM = 240;

export function cargoTotals(lines: CargoLine[], cargoHeightCm = 260): CargoTotals {
  let units = 0;
  let weightKg = 0;
  let volumeCm3 = 0;
  let floorAreaCm2 = 0;
  let longestCm = 0;
  let tallestCm = 0;
  for (const l of lines) {
    units += l.quantity;
    weightKg += l.quantity * l.weightKg;
    volumeCm3 += l.quantity * l.lengthCm * l.widthCm * l.heightCm;
    const layers = l.stackable
      ? Math.max(1, Math.floor(cargoHeightCm / Math.max(1, l.heightCm)))
      : 1;
    const stacks = Math.ceil(l.quantity / layers);
    floorAreaCm2 += stacks * l.lengthCm * l.widthCm;
    longestCm = Math.max(longestCm, l.lengthCm, l.widthCm);
    tallestCm = Math.max(tallestCm, l.heightCm);
  }
  return {
    units,
    weightKg: Math.round(weightKg),
    volumeM3: Math.round(volumeCm3 / 10_000) / 100,
    palletPlaces: Math.ceil(floorAreaCm2 / PALLET_AREA_CM2 - 1e-9),
    loadingMetres: Math.ceil(floorAreaCm2 / TRUCK_WIDTH_CM / 10 - 1e-9) / 10,
    longestCm,
    tallestCm,
  };
}

export type FitProblem =
  | { code: 'too_heavy'; needKg: number; haveKg: number }
  | { code: 'too_many_pallets'; need: number; have: number }
  | { code: 'too_long'; needCm: number; haveCm: number }
  | { code: 'too_tall'; needCm: number; haveCm: number }
  | { code: 'missing_equipment'; equipment: Equipment }
  | { code: 'temperature'; needMinC: number; needMaxC: number }
  | { code: 'dangerous_goods_not_supported' };

/** Does the cargo physically fit this vehicle? Returns every reason it does not. */
export function fitProblems(cargo: CargoRequirements, space: CargoSpace): FitProblem[] {
  const problems: FitProblem[] = [];
  const t = cargoTotals(cargo.lines, space.heightCm);
  if (cargo.dangerousGoods) problems.push({ code: 'dangerous_goods_not_supported' });
  if (t.weightKg > space.payloadKg)
    problems.push({ code: 'too_heavy', needKg: t.weightKg, haveKg: space.payloadKg });
  if (t.palletPlaces > space.palletPlaces)
    problems.push({ code: 'too_many_pallets', need: t.palletPlaces, have: space.palletPlaces });
  // Floor area check against the real cargo space (pallet places alone can hide a long item)
  if (t.longestCm > Math.max(space.lengthCm, space.widthCm))
    problems.push({ code: 'too_long', needCm: t.longestCm, haveCm: space.lengthCm });
  if (t.tallestCm > space.heightCm)
    problems.push({ code: 'too_tall', needCm: t.tallestCm, haveCm: space.heightCm });
  if (
    (cargo.needsTailLiftPickup || cargo.needsTailLiftDelivery) &&
    !space.equipment.includes('tail_lift')
  )
    problems.push({ code: 'missing_equipment', equipment: 'tail_lift' });
  if (cargo.temperature) {
    const ok =
      space.equipment.includes('refrigeration') &&
      space.tempMinC != null &&
      space.tempMaxC != null &&
      space.tempMinC <= cargo.temperature.minC &&
      space.tempMaxC >= cargo.temperature.maxC;
    if (!ok)
      problems.push({
        code: 'temperature',
        needMinC: cargo.temperature.minC,
        needMaxC: cargo.temperature.maxC,
      });
  }
  return problems;
}

/** The vehicle classes whose typical cargo space fits, smallest first. Only bookable classes. */
export function suitableClasses(cargo: CargoRequirements): VehicleClass[] {
  return VEHICLE_CLASSES.filter((v) => v.bookable && fitProblems(cargo, v).length === 0)
    .sort((a, b) => a.rank - b.rank)
    .map((v) => v.class);
}
