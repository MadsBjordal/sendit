import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** PostGIS point in WGS 84, stored as geography so distances are in metres. Written as WKT. */
const geoPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geography(Point, 4326)';
  },
});

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });
/** Money: whole minor units (cents). bigint in the database, number in code (safe up to 9e15). */
const minor = (name: string) => bigint(name, { mode: 'number' });

// ---------------------------------------------------------------- identity & organisations

export const organisations = pgTable('organisations', {
  id: id(),
  kind: text('kind').notNull(), // shipper | carrier | customs_provider | platform
  name: text('name').notNull(),
  country: text('country').notNull(),
  vatNumber: text('vat_number'),
  registrationNumber: text('registration_number'),
  status: text('status').notNull().default('pending_verification'),
  verifiedAt: ts('verified_at'),
  verifiedBy: uuid('verified_by'),
  statusNote: text('status_note'),
  /** Carriers: countries they work in (pickup or delivery) */
  operatingCountries: text('operating_countries')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    emailVerifiedAt: ts('email_verified_at'),
    locale: text('locale').notNull().default('en'),
    /** Platform staff only: platform_admin | platform_ops | platform_finance | platform_support */
    platformRole: text('platform_role'),
    mfaSecret: text('mfa_secret'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: ts('locked_until'),
    active: boolean('active').notNull().default(true),
    /** Per notification kind: { email: false } turns that email off. In-app notifications are always kept. */
    notificationPrefs: jsonb('notification_prefs').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_email_key').on(sql`lower(${t.email})`)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('memberships_org_user_key').on(t.orgId, t.userId),
    index('memberships_user_idx').on(t.userId),
  ],
);

export const invitations = pgTable('invitations', {
  id: id(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organisations.id),
  email: text('email').notNull(),
  role: text('role').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  invitedBy: uuid('invited_by')
    .notNull()
    .references(() => users.id),
  expiresAt: ts('expires_at').notNull(),
  acceptedAt: ts('accepted_at'),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    activeOrgId: uuid('active_org_id').references(() => organisations.id),
    mfaPassed: boolean('mfa_passed').notNull().default(false),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** One-time tokens: email verification and password reset */
export const userTokens = pgTable('user_tokens', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  kind: text('kind').notNull(), // verify_email | reset_password
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
});

/** Emails sent (or, with the log adapter, only recorded) */
export const emailOutbox = pgTable('email_outbox', {
  id: id(),
  to: text('to').notNull(),
  template: text('template').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  provider: text('provider').notNull(),
  sentAt: ts('sent_at'),
  createdAt: createdAt(),
});

export const verificationDocuments = pgTable(
  'verification_documents',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id),
    kind: text('kind').notNull(),
    reference: text('reference').notNull(),
    issuerCountry: text('issuer_country'),
    validFrom: date('valid_from'),
    validUntil: date('valid_until'),
    status: text('status').notNull().default('pending'), // pending | approved | rejected
    reviewNote: text('review_note'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    fileKey: text('file_key'),
    createdAt: createdAt(),
  },
  (t) => [index('verification_documents_org_idx').on(t.orgId)],
);

// ---------------------------------------------------------------- platform configuration

export const countryConfiguration = pgTable('country_configuration', {
  country: text('country').primaryKey(),
  /** Shipments may start or end here */
  enabled: boolean('enabled').notNull().default(false),
  /** Domestic shipments (pickup and delivery both here) */
  domesticEnabled: boolean('domestic_enabled').notNull().default(false),
  note: text('note'),
  updatedBy: uuid('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const pricingConfigurations = pgTable(
  'pricing_configurations',
  {
    id: id(),
    version: text('version').notNull().unique(),
    config: jsonb('config').notNull(),
    active: boolean('active').notNull().default(false),
    note: text('note'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('pricing_one_active')
      .on(t.active)
      .where(sql`${t.active}`),
  ],
);

export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  note: text('note'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Places a company uses often: offered on the booking screen */
export const savedAddresses = pgTable(
  'saved_addresses',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id),
    label: text('label').notNull(),
    addressLine: text('address_line').notNull(),
    postcode: text('postcode').notNull(),
    city: text('city').notNull(),
    country: text('country').notNull(),
    lat: real('lat').notNull(),
    lng: real('lng').notNull(),
    contactName: text('contact_name'),
    contactPhone: text('contact_phone'),
    hasForklift: boolean('has_forklift').notNull().default(false),
    hasLoadingDock: boolean('has_loading_dock').notNull().default(false),
    instructions: text('instructions'),
    lastUsedAt: ts('last_used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('saved_addresses_org_idx').on(t.orgId)],
);

// ---------------------------------------------------------------- fleet

export const vehicles = pgTable(
  'vehicles',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id),
    registration: text('registration').notNull(),
    registrationCountry: text('registration_country').notNull(),
    vehicleClass: text('vehicle_class').notNull(),
    payloadKg: integer('payload_kg').notNull(),
    lengthCm: integer('length_cm').notNull(),
    widthCm: integer('width_cm').notNull(),
    heightCm: integer('height_cm').notNull(),
    palletPlaces: integer('pallet_places').notNull(),
    equipment: text('equipment')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    tempMinC: real('temp_min_c'),
    tempMaxC: real('temp_max_c'),
    baseLocation: geoPoint('base_location').notNull(),
    available: boolean('available').notNull().default(true),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('vehicles_org_registration_key').on(t.orgId, t.registration),
    index('vehicles_base_location_gix').using('gist', t.baseLocation),
  ],
);

/** A carrier's drivers. A driver logs in to the driver app with a user account (role "driver"). */
export const drivers = pgTable(
  'drivers',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id),
    userId: uuid('user_id').references(() => users.id),
    name: text('name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    /** Driving licence categories, e.g. B, C1, C, CE */
    licenceCategories: text('licence_categories')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    licenceValidUntil: date('licence_valid_until'),
    /** Driver qualification card (Code 95 / CPC) */
    cpcValidUntil: date('cpc_valid_until'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    index('drivers_org_idx').on(t.orgId),
    uniqueIndex('drivers_org_email_key').on(t.orgId, sql`lower(${t.email})`),
  ],
);

/** Uploaded files (photos, signatures, proofs of delivery, documents). Stored privately; served only after an access check. */
export const files = pgTable(
  'files',
  {
    id: id(),
    orgId: uuid('org_id').references(() => organisations.id),
    shipmentId: uuid('shipment_id'),
    kind: text('kind').notNull(), // photo | signature | pod | document | invoice | statement | evidence
    storageKey: text('storage_key').notNull().unique(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    fileName: text('file_name'),
    uploadedBy: uuid('uploaded_by'),
    createdAt: createdAt(),
  },
  (t) => [index('files_shipment_idx').on(t.shipmentId)],
);

// ---------------------------------------------------------------- shipments & booking

export const shipments = pgTable(
  'shipments',
  {
    id: id(),
    /** Short human number, e.g. PF-000123 */
    number: bigserial('number', { mode: 'number' }).notNull().unique(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    reference: text('reference'),
    status: text('status').notNull(),
    serviceLevel: text('service_level').notNull(),
    cargo: jsonb('cargo').notNull(),
    weightKg: integer('weight_kg').notNull(),
    palletPlaces: integer('pallet_places').notNull(),
    loadingMetres: real('loading_metres').notNull(),
    volumeM3: real('volume_m3').notNull(),
    vehicleClass: text('vehicle_class').notNull(),
    suitableClasses: text('suitable_classes').array().notNull(),
    distanceKm: integer('distance_km').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    routeSource: text('route_source').notNull(),
    currency: text('currency').notNull(),
    /** Snapshot of the pricing configuration used for this shipment (history, and the same fee rules for every acceptance) */
    pricingVersion: text('pricing_version').notNull(),
    pricingSnapshot: jsonb('pricing_snapshot').notNull(),
    taxContext: jsonb('tax_context').notNull(),
    estimatedPayoutMinor: minor('estimated_payout_minor').notNull(),
    estimatedTotalMinor: minor('estimated_total_minor').notNull(),
    /** Payout shown to carriers: the estimate, or less when the customer's maximum is below it */
    listedPayoutMinor: minor('listed_payout_minor').notNull(),
    /** The customer's maximum authorised total. Private: never sent to carriers. */
    maxPriceMinor: minor('max_price_minor').notNull(),
    /** Prepaid money received for this shipment, net of refunds */
    fundedMinor: minor('funded_minor').notNull().default(0),
    customsResult: text('customs_result').notNull(),
    customsAssessment: jsonb('customs_assessment').notNull(),
    searchRadiusKm: integer('search_radius_km').notNull(),
    publishedAt: ts('published_at'),
    searchExpiresAt: ts('search_expires_at'),
    bookedAt: ts('booked_at'),
    collectedAt: ts('collected_at'),
    deliveredAt: ts('delivered_at'),
    completedAt: ts('completed_at'),
    podFileId: uuid('pod_file_id'),
    cancelledAt: ts('cancelled_at'),
    cancelReason: text('cancel_reason'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('shipments_org_idx').on(t.orgId, t.createdAt),
    index('shipments_status_idx').on(t.status),
  ],
);

export const shipmentLocations = pgTable(
  'shipment_locations',
  {
    id: id(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id),
    kind: text('kind').notNull(), // pickup | delivery
    addressLine: text('address_line').notNull(),
    postcode: text('postcode').notNull(),
    city: text('city').notNull(),
    country: text('country').notNull(),
    point: geoPoint('point').notNull(),
    lat: real('lat').notNull(),
    lng: real('lng').notNull(),
    contactName: text('contact_name'),
    contactPhone: text('contact_phone'),
    windowStart: ts('window_start').notNull(),
    windowEnd: ts('window_end').notNull(),
    hasForklift: boolean('has_forklift').notNull().default(false),
    hasLoadingDock: boolean('has_loading_dock').notNull().default(false),
    instructions: text('instructions'),
  },
  (t) => [
    uniqueIndex('shipment_locations_kind_key').on(t.shipmentId, t.kind),
    index('shipment_locations_point_gix').using('gist', t.point),
  ],
);

export const cargoLines = pgTable('cargo_lines', {
  id: id(),
  shipmentId: uuid('shipment_id')
    .notNull()
    .references(() => shipments.id),
  position: integer('position').notNull(),
  description: text('description'),
  quantity: integer('quantity').notNull(),
  kind: text('kind').$type<'eur_pallet' | 'industrial_pallet' | 'package' | 'other'>().notNull(),
  lengthCm: integer('length_cm').notNull(),
  widthCm: integer('width_cm').notNull(),
  heightCm: integer('height_cm').notNull(),
  weightKg: real('weight_kg').notNull(),
  stackable: boolean('stackable').notNull(),
});

/** Every price worked out for a shipment: the estimate, offers, the booking */
export const priceSnapshots = pgTable('price_snapshots', {
  id: id(),
  shipmentId: uuid('shipment_id')
    .notNull()
    .references(() => shipments.id),
  kind: text('kind').notNull(), // estimate | offer | booking
  pricingVersion: text('pricing_version').notNull(),
  breakdown: jsonb('breakdown').notNull(),
  createdAt: createdAt(),
});

/** Carrier asks for more than fits the customer's maximum: waits for the customer */
export const offers = pgTable(
  'offers',
  {
    id: id(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id),
    carrierOrgId: uuid('carrier_org_id')
      .notNull()
      .references(() => organisations.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    payoutMinor: minor('payout_minor').notNull(),
    platformFeeMinor: minor('platform_fee_minor').notNull(),
    vatMinor: minor('vat_minor').notNull(),
    totalMinor: minor('total_minor').notNull(),
    currency: text('currency').notNull(),
    status: text('status').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    decidedBy: uuid('decided_by'),
    decidedAt: ts('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [index('offers_shipment_idx').on(t.shipmentId, t.status)],
);

export const bookings = pgTable('bookings', {
  id: id(),
  /** UNIQUE: the database itself refuses a second booking of the same shipment */
  shipmentId: uuid('shipment_id')
    .notNull()
    .unique()
    .references(() => shipments.id),
  carrierOrgId: uuid('carrier_org_id')
    .notNull()
    .references(() => organisations.id),
  vehicleId: uuid('vehicle_id')
    .notNull()
    .references(() => vehicles.id),
  offerId: uuid('offer_id').references(() => offers.id),
  payoutMinor: minor('payout_minor').notNull(),
  platformFeeMinor: minor('platform_fee_minor').notNull(),
  netMinor: minor('net_minor').notNull(),
  vatMinor: minor('vat_minor').notNull(),
  totalMinor: minor('total_minor').notNull(),
  currency: text('currency').notNull(),
  pricingVersion: text('pricing_version').notNull(),
  acceptedBy: uuid('accepted_by')
    .notNull()
    .references(() => users.id),
  cabotageConfirmed: boolean('cabotage_confirmed').notNull().default(false),
  driverId: uuid('driver_id'),
  assignedAt: ts('assigned_at'),
  createdAt: createdAt(),
});

/** Every carrier acceptance attempt, with its idempotency key and outcome */
export const acceptAttempts = pgTable(
  'accept_attempts',
  {
    id: id(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id),
    carrierOrgId: uuid('carrier_org_id')
      .notNull()
      .references(() => organisations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    idempotencyKey: text('idempotency_key').notNull(),
    result: text('result').notNull(), // booked | offer_pending | already_assigned | not_available | not_eligible
    response: jsonb('response').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('accept_attempts_idem_key').on(t.carrierOrgId, t.idempotencyKey)],
);

export const shipmentEvents = pgTable(
  'shipment_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id),
    kind: text('kind').notNull(),
    actorUserId: uuid('actor_user_id'),
    actorOrgId: uuid('actor_org_id'),
    data: jsonb('data').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('shipment_events_shipment_idx').on(t.shipmentId, t.id)],
);

/**
 * What happened on the road, recorded by the driver (or the carrier's dispatcher): arrival, loading
 * with counted quantities, departure, border crossing, delay, delivery with recipient and signature.
 * The client event id makes offline retries safe.
 */
export const tripEvents = pgTable(
  'trip_events',
  {
    id: id(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id),
    clientEventId: text('client_event_id').notNull(),
    action: text('action').notNull(),
    occurredAt: ts('occurred_at').notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
    lat: real('lat'),
    lng: real('lng'),
    countedUnits: integer('counted_units'),
    discrepancy: text('discrepancy'),
    damage: boolean('damage').notNull().default(false),
    damageNote: text('damage_note'),
    recipientName: text('recipient_name'),
    signatureFileId: uuid('signature_file_id'),
    photoFileIds: uuid('photo_file_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    delayMinutes: integer('delay_minutes'),
    note: text('note'),
    country: text('country'),
    recordedBy: uuid('recorded_by').notNull(),
    recordedAs: text('recorded_as').notNull(), // driver | dispatcher
  },
  (t) => [
    uniqueIndex('trip_events_client_key').on(t.shipmentId, t.clientEventId),
    index('trip_events_shipment_idx').on(t.shipmentId, t.occurredAt),
  ],
);

/** Positions sent by the driver app during an active trip only. Purged after the retention period. */
export const trackingPositions = pgTable(
  'tracking_positions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id),
    driverId: uuid('driver_id').notNull(),
    at: ts('at').notNull(),
    lat: real('lat').notNull(),
    lng: real('lng').notNull(),
    accuracyM: real('accuracy_m'),
    speedKmh: real('speed_kmh'),
    createdAt: createdAt(),
  },
  (t) => [index('tracking_positions_shipment_idx').on(t.shipmentId, t.at)],
);

/** Messages on a shipment between the people allowed to see it */
export const messages = pgTable(
  'messages',
  {
    id: id(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id),
    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => users.id),
    senderOrgId: uuid('sender_org_id'),
    senderRole: text('sender_role').notNull(), // shipper | carrier | driver | customs | platform
    body: text('body').notNull(),
    fileId: uuid('file_id'),
    createdAt: createdAt(),
  },
  (t) => [index('messages_shipment_idx').on(t.shipmentId, t.createdAt)],
);

export const messageReads = pgTable(
  'message_reads',
  {
    shipmentId: uuid('shipment_id').notNull(),
    userId: uuid('user_id').notNull(),
    lastReadAt: ts('last_read_at').notNull(),
  },
  (t) => [uniqueIndex('message_reads_key').on(t.shipmentId, t.userId)],
);

// ---------------------------------------------------------------- money

export const payments = pgTable(
  'payments',
  {
    id: id(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id),
    purpose: text('purpose').notNull(), // prepayment | top_up
    offerId: uuid('offer_id').references(() => offers.id),
    amountMinor: minor('amount_minor').notNull(),
    currency: text('currency').notNull(),
    provider: text('provider').notNull(),
    providerRef: text('provider_ref').notNull(),
    status: text('status').notNull().default('pending'),
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payments_provider_ref_key').on(t.provider, t.providerRef),
    index('payments_shipment_idx').on(t.shipmentId),
  ],
);

/** Raw provider webhooks, stored once each (duplicates are recognised by the provider's event id) */
export const paymentProviderEvents = pgTable(
  'payment_provider_events',
  {
    id: id(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    result: text('result'),
    receivedAt: ts('received_at').notNull().defaultNow(),
    processedAt: ts('processed_at'),
  },
  (t) => [uniqueIndex('payment_provider_events_key').on(t.provider, t.providerEventId)],
);

export const refunds = pgTable('refunds', {
  id: id(),
  paymentId: uuid('payment_id')
    .notNull()
    .references(() => payments.id),
  shipmentId: uuid('shipment_id')
    .notNull()
    .references(() => shipments.id),
  amountMinor: minor('amount_minor').notNull(),
  currency: text('currency').notNull(),
  reason: text('reason').notNull(),
  status: text('status').notNull(), // pending | succeeded | failed
  providerRef: text('provider_ref'),
  createdAt: createdAt(),
});

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: id(),
    /** psp_clearing | customer_funds | carrier_payable | platform_revenue_deferred | platform_revenue | vat_payable */
    code: text('code').notNull(),
    orgId: uuid('org_id').references(() => organisations.id),
    currency: text('currency').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ledger_accounts_key').on(
      t.code,
      sql`coalesce(${t.orgId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.currency,
    ),
  ],
);

export const ledgerTransactions = pgTable('ledger_transactions', {
  id: id(),
  kind: text('kind').notNull(), // payment_received | booking | refund | payout | adjustment
  refType: text('ref_type').notNull(),
  refId: uuid('ref_id').notNull(),
  /** The same financial event is never booked twice */
  idempotencyKey: text('idempotency_key').notNull().unique(),
  memo: text('memo'),
  createdAt: createdAt(),
});

/** Double entry: debit positive, credit negative; each transaction sums to zero (checked by a trigger). Append-only. */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => ledgerAccounts.id),
    amountMinor: minor('amount_minor').notNull(),
    currency: text('currency').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_entries_account_idx').on(t.accountId),
    index('ledger_entries_tx_idx').on(t.transactionId),
  ],
);

/** The platform's promise to pay the carrier for a booking */
export const carrierObligations = pgTable('carrier_obligations', {
  id: id(),
  bookingId: uuid('booking_id')
    .notNull()
    .unique()
    .references(() => bookings.id),
  carrierOrgId: uuid('carrier_org_id')
    .notNull()
    .references(() => organisations.id),
  amountMinor: minor('amount_minor').notNull(),
  currency: text('currency').notNull(),
  /** committed → payable (delivery verified) → paid; or cancelled / disputed */
  status: text('status').notNull().default('committed'),
  /** Backed by collected customer money (prepaid) – the condition for showing the guarantee */
  funded: boolean('funded').notNull(),
  conditions: text('conditions').notNull(),
  payableAt: ts('payable_at'),
  paidAt: ts('paid_at'),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- platform

export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    /** Optional: only one queued/running job with this key */
    dedupeKey: text('dedupe_key'),
    status: text('status').notNull().default('queued'), // queued | running | done | dead
    runAt: ts('run_at').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    lockedAt: ts('locked_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('jobs_due_idx')
      .on(t.runAt)
      .where(sql`${t.status} = 'queued'`),
    uniqueIndex('jobs_dedupe_key')
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    orgId: uuid('org_id'),
    kind: text('kind').notNull(),
    shipmentId: uuid('shipment_id'),
    data: jsonb('data').notNull().default({}),
    dedupeKey: text('dedupe_key').notNull(),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('notifications_dedupe_key').on(t.userId, t.dedupeKey),
    index('notifications_user_idx').on(t.userId, t.createdAt),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorUserId: uuid('actor_user_id'),
    actorOrgId: uuid('actor_org_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: text('ip'),
    data: jsonb('data').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_created_idx').on(t.createdAt)],
);
