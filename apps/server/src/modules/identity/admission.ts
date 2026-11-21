// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * How a Bubble deployment admits people who sign in: the deployment's
 * `admission` server record, kept by the structured backend beside the other
 * deployment settings, so it survives restarts and container replacement.
 *
 * Admission itself stays a Bubble grant: this record only says whether
 * automatic admission is on, and who it must never readmit. Bubble's People
 * directory (`bubble.ts`) reads and writes it under its per-person member-grant
 * lock, so a grant decision and a revocation for one person never interleave.
 */

import { admissionRecordSchema } from '../server-record-shapes.js';
import { getServerRecords } from '../storage/index.js';

import type { AdmissionRecord } from '../server-record-shapes.js';

const RECORD = { owner: null, name: 'admission' } as const;

/** A deployment that never saved the record admits people by hand. */
const MANUAL: AdmissionRecord = { automatic: false, blocked: {} };

/**
 * The record as stored, or manual admission with nobody blocked when it was
 * never written.
 *
 * @throws when the stored value is damaged. Callers deciding a grant treat
 * that as "do not admit".
 */
export async function readAdmission(): Promise<AdmissionRecord> {
  return parse(await getServerRecords().get(RECORD));
}

/** Turn automatic admission on or off; blocks are kept either way. */
export async function setAutomaticAdmission(
  automatic: boolean,
): Promise<AdmissionRecord> {
  return getServerRecords().update(RECORD, (current) => ({
    ...parse(current),
    automatic,
  }));
}

/**
 * Record that an administrator removed `principalId`'s access, so automatic
 * admission does not readmit them. Kept whether or not automatic admission is
 * on now, so turning it on later readmits nobody an administrator removed.
 */
export async function blockAdmission(
  principalId: string,
  by: string,
): Promise<void> {
  await getServerRecords().update(RECORD, (current) => {
    const record = parse(current);
    return {
      ...record,
      blocked: {
        ...record.blocked,
        [principalId]: { blockedAt: new Date().toISOString(), blockedBy: by },
      },
    };
  });
}

/** An administrator gave `principalId` access again. */
export async function clearAdmissionBlock(principalId: string): Promise<void> {
  await getServerRecords().update(RECORD, (current) => {
    const record = parse(current);
    const blocked = { ...record.blocked };
    delete blocked[principalId];
    return { ...record, blocked };
  });
}

function parse(current: unknown): AdmissionRecord {
  return current === null ? MANUAL : admissionRecordSchema.parse(current);
}
