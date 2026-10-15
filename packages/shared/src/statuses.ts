/**
 * Shipment, offer, booking and payment states are kept separate on purpose: the transport,
 * the customs work and the money each move on their own.
 */
export const SHIPMENT_STATUSES = [
  'draft', // being entered, not paid
  'awaiting_payment', // published by the customer, waiting for the prepayment to arrive
  'searching', // paid; offered to carriers
  'booked', // a carrier won it
  'in_transit', // collected (phase 3)
  'delivered', // delivered, proof of delivery under review (phase 3)
  'completed', // delivery accepted; carrier payout due
  'expired', // no carrier within the search time
  'cancelled',
  'disputed', // the customer disputes the delivery: payout held until resolved
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** States in which carriers may see and accept the shipment */
export const OPEN_FOR_CARRIERS: ShipmentStatus[] = ['searching'];

export const OFFER_STATUSES = [
  'pending_customer', // above the customer's maximum: waiting for their decision
  'approved', // customer approved; booking is finalising (top-up payment)
  'booked', // became the booking
  'rejected', // customer said no
  'expired', // ran out of time
  'superseded', // another carrier got the shipment first
  'withdrawn', // carrier took it back
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'cancelled'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_PURPOSES = ['prepayment', 'top_up'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export const ORG_KINDS = ['shipper', 'carrier', 'customs_provider', 'platform'] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

export const ORG_STATUSES = ['pending_verification', 'verified', 'rejected', 'suspended'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const MEMBER_ROLES = [
  'owner',
  'admin',
  'dispatcher',
  'finance',
  'member',
  'driver',
] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** What each role may do inside its own organisation. Checked on the server for every request. */
export const ROLE_PERMISSIONS: Record<MemberRole, string[]> = {
  owner: [
    'org.manage',
    'members.manage',
    'shipments.create',
    'shipments.view',
    'offers.decide',
    'payments.manage',
    'loads.accept',
    'fleet.manage',
    'finance.view',
  ],
  admin: [
    'org.manage',
    'members.manage',
    'shipments.create',
    'shipments.view',
    'offers.decide',
    'payments.manage',
    'loads.accept',
    'fleet.manage',
    'finance.view',
  ],
  dispatcher: [
    'shipments.create',
    'shipments.view',
    'offers.decide',
    'loads.accept',
    'fleet.manage',
  ],
  finance: ['shipments.view', 'payments.manage', 'finance.view'],
  member: ['shipments.create', 'shipments.view'],
  driver: ['shipments.view'],
};

export function roleCan(role: MemberRole, permission: string): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const PLATFORM_ROLES = [
  'platform_admin',
  'platform_ops',
  'platform_finance',
  'platform_support',
] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** Documents a carrier must have verified before it may accept loads */
export const CARRIER_REQUIRED_DOCUMENTS = [
  'operator_licence',
  'carrier_liability_insurance',
] as const;
export const VERIFICATION_DOCUMENT_KINDS = [
  'company_registration',
  'operator_licence', // EU Community Licence or national licence
  'carrier_liability_insurance', // CMR liability insurance
  'vat_registration',
  'customs_authorisation',
] as const;
export type VerificationDocumentKind = (typeof VERIFICATION_DOCUMENT_KINDS)[number];
