/**
 * Auto-refresh logic for dynamic wave absorption.
 *
 * Given a set of new ticket candidates and the current convoy state,
 * places tickets into existing pending waves (fill) or creates new
 * appended waves (overflow), respecting dependency ordering,
 * maxTicketsPerWave limits, and file-overlap safety.
 */

import { pathsOverlap } from "../core/path-overlap.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RefreshCandidate {
  ticketId: string;
  internalId: number;
  affectedPaths: string[];
  /** Ticket IDs that must finish before this one can start. */
  blockerTicketIds: string[];
}

export interface WaveSlot {
  waveIndex: number;
  currentCount: number;
  /** "pending" = not yet dispatched; others are frozen. */
  status: "pending" | "dispatched" | "active" | "completed";
  /** affectedPaths per existing ticket in this wave (for overlap checks). */
  existingPaths: string[][];
}

export interface RefreshResult {
  /** ticketId → absolute wave index. */
  placements: Map<string, number>;
  /** How many brand-new waves were appended beyond existingWaveCount. */
  newWavesAppended: number;
  fileOverlapWarnings: Array<{
    wave: number;
    ticketA: string;
    ticketB: string;
    overlappingPaths: string[];
  }>;
  /** Tickets whose dependencies could not be resolved (outside convoy). */
  deferred: string[];
}

// ---------------------------------------------------------------------------
// placeNewTickets
// ---------------------------------------------------------------------------

/**
 * Place new ticket candidates into a running convoy.
 *
 * Strategy: "fill pending waves, then append new ones".
 *
 * 1. Compute the minimum wave each ticket can go into based on its blockers.
 * 2. For each ticket (sorted by min wave), find the first pending wave
 *    that has room and no file overlap.
 * 3. Tickets that cannot be placed go into newly appended waves.
 */
export function placeNewTickets(
  candidates: RefreshCandidate[],
  existingWaves: WaveSlot[],
  currentWave: number,
  convoyTicketIds: Set<string>,
  convoyTicketWaveMap: Map<string, number>,
  maxTicketsPerWave: number,
): RefreshResult {
  const placements = new Map<string, number>();
  const deferred: string[] = [];
  const fileOverlapWarnings: RefreshResult["fileOverlapWarnings"] = [];

  if (candidates.length === 0) {
    return { placements, newWavesAppended: 0, fileOverlapWarnings, deferred };
  }

  // Build a set of candidate ticket IDs for inter-candidate dep resolution
  const candidateIds = new Set(candidates.map((c) => c.ticketId));

  // Track placements of candidates for inter-candidate dependency ordering
  const candidateWaveMap = new Map<string, number>();

  // Compute min wave for each candidate and identify deferred ones
  const placeable: Array<{ candidate: RefreshCandidate; minWave: number }> = [];

  for (const candidate of candidates) {
    let minWave = 0;
    let canPlace = true;

    for (const blockerId of candidate.blockerTicketIds) {
      if (convoyTicketIds.has(blockerId)) {
        // Blocker is in the convoy — ticket must go after its wave
        const blockerWave = convoyTicketWaveMap.get(blockerId);
        if (blockerWave !== undefined) {
          minWave = Math.max(minWave, blockerWave + 1);
        }
      } else if (candidateIds.has(blockerId)) {
        // Blocker is another candidate — handled in placement order below
        continue;
      } else {
        // Blocker is outside convoy and candidates — cannot place
        canPlace = false;
        break;
      }
    }

    if (!canPlace) {
      deferred.push(candidate.ticketId);
    } else {
      placeable.push({ candidate, minWave });
    }
  }

  // Sort by minWave so tickets with fewer constraints are placed first
  placeable.sort((a, b) => a.minWave - b.minWave);

  // Clone wave slots for mutation during fill phase
  const slots = existingWaves.map((w) => ({
    ...w,
    currentCount: w.currentCount,
    // Clone paths arrays for mutation
    existingPaths: [...w.existingPaths],
  }));

  let maxWaveIndex = slots.length > 0
    ? Math.max(...slots.map((s) => s.waveIndex))
    : -1;

  // Track paths added to waves by newly placed tickets (for overlap checks)
  const addedPathsByWave = new Map<number, string[][]>();

  for (const { candidate, minWave: baseMinWave } of placeable) {
    // Re-check inter-candidate dependencies
    let minWave = baseMinWave;
    let hasUnresolvableCandidateDep = false;

    for (const blockerId of candidate.blockerTicketIds) {
      if (candidateIds.has(blockerId)) {
        const depWave = candidateWaveMap.get(blockerId);
        if (depWave !== undefined) {
          minWave = Math.max(minWave, depWave + 1);
        } else {
          // Candidate dep not yet placed — defer this ticket to append phase
          hasUnresolvableCandidateDep = true;
          break;
        }
      }
    }

    if (hasUnresolvableCandidateDep) {
      // Will be handled in append phase below
      continue;
    }

    // --- Fill phase: try existing pending waves ---
    let placed = false;

    for (const slot of slots) {
      if (slot.waveIndex < minWave) continue;
      if (slot.status !== "pending") continue;
      if (slot.currentCount >= maxTicketsPerWave) continue;

      // Check file overlap with existing + already-placed tickets in this wave
      const allPaths = [
        ...slot.existingPaths,
        ...(addedPathsByWave.get(slot.waveIndex) ?? []),
      ];
      const overlap = findOverlaps(candidate.ticketId, candidate.affectedPaths, allPaths, slot.waveIndex, fileOverlapWarnings);
      if (overlap) continue;

      // Place here
      placements.set(candidate.ticketId, slot.waveIndex);
      candidateWaveMap.set(candidate.ticketId, slot.waveIndex);
      slot.currentCount++;
      const wavePaths = addedPathsByWave.get(slot.waveIndex) ?? [];
      wavePaths.push(candidate.affectedPaths);
      addedPathsByWave.set(slot.waveIndex, wavePaths);
      placed = true;
      break;
    }

    if (!placed) {
      // --- Append phase: create new wave ---
      const targetWave = Math.max(minWave, maxWaveIndex + 1);

      // Check if there's an already-appended wave with room
      const existingAppended = slots.find(
        (s) => s.waveIndex === targetWave && s.currentCount < maxTicketsPerWave,
      );

      if (existingAppended) {
        const allPaths = addedPathsByWave.get(targetWave) ?? [];
        const overlap = findOverlaps(candidate.ticketId, candidate.affectedPaths, allPaths, targetWave, fileOverlapWarnings);

        if (!overlap) {
          placements.set(candidate.ticketId, targetWave);
          candidateWaveMap.set(candidate.ticketId, targetWave);
          existingAppended.currentCount++;
          const wavePaths = addedPathsByWave.get(targetWave) ?? [];
          wavePaths.push(candidate.affectedPaths);
          addedPathsByWave.set(targetWave, wavePaths);
          continue;
        }
      }

      // Create brand new wave
      const newWaveIdx = maxWaveIndex + 1;
      maxWaveIndex = newWaveIdx;
      slots.push({
        waveIndex: newWaveIdx,
        currentCount: 1,
        status: "pending",
        existingPaths: [],
      });
      addedPathsByWave.set(newWaveIdx, [candidate.affectedPaths]);
      placements.set(candidate.ticketId, newWaveIdx);
      candidateWaveMap.set(candidate.ticketId, newWaveIdx);
    }
  }

  // Count how many new waves were appended beyond the original
  const originalMaxWave = existingWaves.length > 0
    ? Math.max(...existingWaves.map((s) => s.waveIndex))
    : -1;
  const newWavesAppended = maxWaveIndex > originalMaxWave
    ? maxWaveIndex - originalMaxWave
    : 0;

  return { placements, newWavesAppended, fileOverlapWarnings, deferred };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a candidate's paths overlap with any existing paths in a wave.
 * Returns true if overlap found (meaning the candidate should NOT go in this wave).
 * Does NOT add to fileOverlapWarnings — overlaps during fill are expected skips.
 */
function findOverlaps(
  _ticketId: string,
  candidatePaths: string[],
  existingPathSets: string[][],
  _waveIndex: number,
  _warnings: RefreshResult["fileOverlapWarnings"],
): boolean {
  for (const existingPaths of existingPathSets) {
    for (const cp of candidatePaths) {
      for (const ep of existingPaths) {
        if (pathsOverlap(cp, ep)) {
          return true;
        }
      }
    }
  }
  return false;
}
