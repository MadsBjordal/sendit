import { z } from 'zod';
import { SERVICE_LEVELS } from './pricing';

/** Input shapes shared by the API (validation) and the web app (forms). */

export const countryCode = z.string().regex(/^[A-Z]{2}$/, 'Two-letter country code');

export const registerSchema = z.object({
  organisation: z.object({
    name: z.string().trim().min(2).max(200),
    kind: z.enum(['shipper', 'carrier', 'customs_provider']),
    country: countryCode,
    vatNumber: z.string().trim().max(32).optional().nullable(),
    registrationNumber: z.string().trim().max(64).optional().nullable(),
  }),
  user: z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(12, 'At least 12 characters').max(200),
    locale: z.enum(['en', 'de', 'pl', 'fr', 'es', 'it', 'nl']).default('en'),
  }),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
  mfaCode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

export const placeSchema = z.object({
  addressLine: z.string().trim().min(3).max(300),
  postcode: z.string().trim().min(2).max(16),
  city: z.string().trim().min(1).max(120),
  country: countryCode,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  contactName: z.string().trim().max(200).optional().nullable(),
  contactPhone: z.string().trim().max(40).optional().nullable(),
  windowStart: z.string().datetime({ offset: true }),
  windowEnd: z.string().datetime({ offset: true }),
  hasForklift: z.boolean().default(false),
  hasLoadingDock: z.boolean().default(false),
  instructions: z.string().trim().max(2000).optional().nullable(),
});

export const cargoLineSchema = z.object({
  description: z.string().trim().max(300).optional(),
  quantity: z.number().int().min(1).max(1000),
  kind: z.enum(['eur_pallet', 'industrial_pallet', 'package', 'other']),
  lengthCm: z.number().int().min(1).max(2000),
  widthCm: z.number().int().min(1).max(300),
  heightCm: z.number().int().min(1).max(400),
  weightKg: z.number().min(0.1).max(40000),
  stackable: z.boolean().default(false),
});

export const shipmentInputSchema = z
  .object({
    pickup: placeSchema,
    delivery: placeSchema,
    cargo: z.object({
      description: z.string().trim().min(2).max(500),
      category: z.enum([
        'general',
        'food',
        'machinery',
        'building_materials',
        'retail_goods',
        'automotive',
        'chemicals',
        'other',
      ]),
      lines: z.array(cargoLineSchema).min(1).max(50),
      declaredValueMinor: z.number().int().min(0).max(1_000_000_000_00).optional().nullable(),
      fragile: z.boolean().default(false),
      temperature: z
        .object({ minC: z.number().min(-30).max(30), maxC: z.number().min(-30).max(30) })
        .nullable()
        .optional(),
      dangerousGoods: z.boolean().default(false),
      needsTailLiftPickup: z.boolean().default(false),
      needsTailLiftDelivery: z.boolean().default(false),
      goodsStatus: z.enum(['union', 'non_union', 'unknown']).default('unknown'),
      hsCode: z
        .string()
        .regex(/^\d{4,10}$/)
        .optional()
        .nullable(),
    }),
    serviceLevel: z.enum(SERVICE_LEVELS as [string, ...string[]]),
    /** The customer's maximum total (incl. platform charges and VAT), minor units */
    maxPriceMinor: z.number().int().positive().max(1_000_000_00),
    reference: z.string().trim().max(100).optional().nullable(),
  })
  .refine((s) => new Date(s.pickup.windowEnd) > new Date(s.pickup.windowStart), {
    message: 'Pickup window ends before it starts',
    path: ['pickup', 'windowEnd'],
  })
  .refine((s) => new Date(s.delivery.windowEnd) > new Date(s.delivery.windowStart), {
    message: 'Delivery window ends before it starts',
    path: ['delivery', 'windowEnd'],
  })
  .refine((s) => new Date(s.delivery.windowEnd) > new Date(s.pickup.windowStart), {
    message: 'Delivery must end after pickup starts',
    path: ['delivery', 'windowEnd'],
  })
  .refine((s) => !s.cargo.temperature || s.cargo.temperature.minC <= s.cargo.temperature.maxC, {
    message: 'Temperature range is reversed',
    path: ['cargo', 'temperature'],
  });
export type ShipmentInput = z.infer<typeof shipmentInputSchema>;

export const quoteInputSchema = z.object({
  pickup: placeSchema.pick({ country: true, postcode: true, lat: true, lng: true }),
  delivery: placeSchema.pick({ country: true, postcode: true, lat: true, lng: true }),
  lines: z.array(cargoLineSchema).min(1).max(50),
  serviceLevel: z.enum(SERVICE_LEVELS as [string, ...string[]]),
  temperature: z.object({ minC: z.number(), maxC: z.number() }).nullable().optional(),
  needsTailLiftPickup: z.boolean().default(false),
  needsTailLiftDelivery: z.boolean().default(false),
  goodsStatus: z.enum(['union', 'non_union', 'unknown']).default('unknown'),
});
export type QuoteInput = z.infer<typeof quoteInputSchema>;

export const vehicleInputSchema = z.object({
  registration: z.string().trim().min(2).max(20),
  registrationCountry: countryCode,
  vehicleClass: z.enum([
    'van_light',
    'van_large',
    'box_truck',
    'rigid_truck',
    'curtainsider',
    'articulated',
    'refrigerated',
    'flatbed',
    'specialist',
  ]),
  payloadKg: z.number().int().min(100).max(45000),
  lengthCm: z.number().int().min(100).max(1700),
  widthCm: z.number().int().min(100).max(300),
  heightCm: z.number().int().min(100).max(450),
  palletPlaces: z.number().int().min(0).max(40),
  equipment: z
    .array(
      z.enum(['tail_lift', 'refrigeration', 'side_loading', 'top_loading', 'pallet_jack', 'adr']),
    )
    .default([]),
  tempMinC: z.number().min(-30).max(30).nullable().optional(),
  tempMaxC: z.number().min(-30).max(30).nullable().optional(),
  baseLat: z.number().min(-90).max(90),
  baseLng: z.number().min(-180).max(180),
  available: z.boolean().default(true),
});
export type VehicleInput = z.infer<typeof vehicleInputSchema>;

export const acceptLoadSchema = z.object({
  vehicleId: z.string().uuid(),
  /** Leave out to accept the listed payout; give an amount to ask for a different payout */
  payoutMinor: z.number().int().positive().max(1_000_000_00).optional(),
  idempotencyKey: z.string().min(8).max(100),
});
