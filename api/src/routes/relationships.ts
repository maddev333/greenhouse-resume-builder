import { Router } from 'express';
import type { Relationship, FactVersion } from '@greenhouse-resume-builder/shared';
import { relationshipRepo, factVersionRepo, personRepo } from '../db/repo';

const router = Router();

/** Coerce a fact value (string, or object carrying a location-ish field) to a location string. */
function factValueToLocation(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const candidate = v.location ?? v.city ?? v.value;
    if (typeof candidate === 'string') return candidate.trim() || null;
  }
  if (value != null && typeof value !== 'object') return String(value).trim() || null;
  return null;
}

/**
 * Relationship graph (neighborhood) for a person: the center node plus every person
 * connected by a suggested/confirmed edge (either direction). Each node carries a display
 * name and a primary location (latest `profile.location` fact) so the UI can render both a
 * node-link graph and a geographic map.
 */
router.get('/:personId/graph', async (req: any, res: any) => {
  try {
    const centerId = req.params.personId;
    const edgesRaw = await relationshipRepo.forPersonGraph(centerId);
    // Drop self-loops — never a meaningful person-to-person edge.
    const edges = (edgesRaw as unknown as Relationship[]).filter(r => r.fromPersonId !== r.toPersonId);

    const nodeIds = Array.from(new Set([centerId, ...edges.flatMap(e => [e.fromPersonId, e.toPersonId])]));

    const nodes = await Promise.all(nodeIds.map(async (id) => {
      const person = await personRepo.getById(id).catch(() => null);
      let location: string | null = null;
      try {
        const locFacts = await factVersionRepo.getByFactKey(id, 'profile.location');
        location = factValueToLocation((locFacts as unknown as FactVersion[])[0]?.factValue);
      } catch { /* location is best-effort */ }
      return { id, name: person?.canonicalName ?? null, isCenter: id === centerId, location };
    }));

    res.json({
      centerId,
      nodes,
      edges: edges.map(e => ({
        relationshipId: e.id,
        fromPersonId: e.fromPersonId,
        toPersonId: e.toPersonId,
        relationshipType: e.relationshipType,
        status: e.status,
        confidence: e.confidence ?? 0,
      })),
    });
  } catch (err) {
    console.error('[Relationships] Graph error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:personId/suggested', async (req: any, res: any) => {
  try {
    const personId = req.params.personId;
    const candidates = await relationshipRepo.suggested(personId);
    // Drop self-loops (from === to) — they are never a meaningful person-to-person edge.
    const rels = (candidates as unknown as Relationship[]).filter(r => r.fromPersonId !== r.toPersonId);

    // Resolve person IDs → display names so the UI can show "Jane Smith → John Doe".
    const personIds = Array.from(new Set(rels.flatMap(r => [r.fromPersonId, r.toPersonId])));
    const nameById = new Map<string, string>();
    await Promise.all(personIds.map(async id => {
      const p = await personRepo.getById(id).catch(() => null);
      if (p?.canonicalName) nameById.set(id, p.canonicalName);
    }));

    const expFacts = await factVersionRepo.allByPersonSection(personId, 'experience');
    const typedExpFacts: FactVersion[] = (expFacts as unknown as FactVersion[]);

    res.json({
      candidates: rels.map(r => ({
        relationshipId: r.id, fromPersonId: r.fromPersonId, toPersonId: r.toPersonId,
        fromPersonName: nameById.get(r.fromPersonId) ?? null,
        toPersonName: nameById.get(r.toPersonId) ?? null,
        relationshipType: r.relationshipType, status: r.status, confidence: r.confidence ?? 0,
      })),
      evidenceFacts: typedExpFacts.map(f => ({ factKey: f.factKey, factValue: f.factValue, personId: f.personId })),
    });
  } catch (err) {
    console.error('[Relationships] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:relationshipId', async (req: any, res: any) => {
  try {
    const status = req.body.status;

    if (status === 'suggested') {
      const exists = await relationshipRepo.edgeExists(req.body.fromPersonId, req.body.toPersonId);
      if (exists) return res.status(409).json({ error: 'Edge already exists' });

      const relId = `rel_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await relationshipRepo.create({
        id: relId, tenantId: req.user?.tenantId || req.tenantId || 'tenant',
        fromPersonId: req.body.fromPersonId, toPersonId: req.body.toPersonId,
        relationshipType: req.body.relationshipType || 'shared_employer',
        status: 'suggested' as const,
        inferredByAgent: false,
        evidenceFactVersionIds: [], evidenceSourceDocumentIds: [],
      } as unknown as (Relationship & { id: string }) as any);

      // Return aligned with Relationship DTO (no hardcoded defaults)
      res.status(201).json({
        id: relId,
        tenantId: req.user?.tenantId || req.tenantId || 'tenant',
        fromPersonId: req.body.fromPersonId,
        toPersonId: req.body.toPersonId,
        relationshipType: req.body.relationshipType || 'shared_employer',
        status: 'suggested' as const,
        inferredByAgent: false,
        evidenceFactVersionIds: [],
        evidenceSourceDocumentIds: [],
      });
    } else if (status === 'confirmed' || status === 'rejected') {
      const edge = await relationshipRepo.getById(req.params.relationshipId);
      if (!edge) return res.status(404).json({ error: 'Not found' });

      await relationshipRepo.updateStatus(req.params.relationshipId, status as Relationship['status'], req.user?.id || req.userId || 'system');
      res.json({ updated: true });
    } else {
      res.status(400).json({ error: 'Invalid status' });
    }
  } catch (err) {
    console.error('[Relationships] Patch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
